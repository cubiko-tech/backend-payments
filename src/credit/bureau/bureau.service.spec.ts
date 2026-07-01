import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'

import { BureauService } from './bureau.service'
import { mapBand, BUREAU_THRESHOLDS } from './bureau.config'
import { CreditProfile } from '../entities/creditProfile.entity'
import { BureauCheck } from '../entities/bureauCheck.entity'
import { AuditService } from '../../audit/audit.service'

describe('mapBand', () => {
  const t = BUREAU_THRESHOLDS.manual // {veto<300, high<500, medium<600, clear}
  it.each([
    [250, 'veto'],
    [400, 'high_risk'],
    [550, 'medium_risk'],
    [700, 'clear'],
    [299, 'veto'],
    [300, 'high_risk'],
    [600, 'clear'],
  ])('mapea %i → %s', (score, band) => {
    expect(mapBand(score as number, t)).toBe(band)
  })
})

describe('BureauService', () => {
  let service: BureauService
  let profileRead: { findOne: jest.Mock }
  let profileWrite: { findOne: jest.Mock; create: jest.Mock; save: jest.Mock }
  let checkRead: { findOne: jest.Mock; find: jest.Mock }
  let checkWrite: { create: jest.Mock; save: jest.Mock }
  let audit: { log: jest.Mock }

  beforeEach(async () => {
    profileRead = { findOne: jest.fn() }
    profileWrite = { findOne: jest.fn(), create: jest.fn((d) => d), save: jest.fn((d) => Promise.resolve({ id: 'p1', ...d })) }
    checkRead = { findOne: jest.fn(), find: jest.fn() }
    checkWrite = { create: jest.fn((d) => d), save: jest.fn((d) => Promise.resolve({ id: 'c1', ...d })) }
    audit = { log: jest.fn().mockResolvedValue({}) }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BureauService,
        { provide: getRepositoryToken(CreditProfile, 'DBWrite'), useValue: profileWrite },
        { provide: getRepositoryToken(CreditProfile, 'DBRead'), useValue: profileRead },
        { provide: getRepositoryToken(BureauCheck, 'DBWrite'), useValue: checkWrite },
        { provide: getRepositoryToken(BureauCheck, 'DBRead'), useValue: checkRead },
        { provide: AuditService, useValue: audit },
      ],
    }).compile()

    service = module.get(BureauService)
  })

  const withConsent = { brandId: 'b1', document: '900', documentType: 'NIT', consentGrantedAt: new Date() }

  describe('createManualCheck', () => {
    it('rechaza si el perfil no tiene documento (400)', async () => {
      profileRead.findOne.mockResolvedValue(null)
      await expect(service.createManualCheck('b1', { rawScore: 700 }, 'op')).rejects.toMatchObject({ status: 400 })
    })

    it('rechaza sin consentimiento vigente (403)', async () => {
      profileRead.findOne.mockResolvedValue({ ...withConsent, consentGrantedAt: null })
      await expect(service.createManualCheck('b1', { rawScore: 700 }, 'op')).rejects.toMatchObject({ status: 403 })
    })

    it('mapea rawScore a banda, guarda y audita', async () => {
      profileRead.findOne.mockResolvedValue(withConsent)
      const check = await service.createManualCheck('b1', { rawScore: 250 }, 'op')
      expect(check.band).toBe('veto')
      expect(check.document).toBe('900')
      expect(check.validUntil).toBeInstanceOf(Date)
      expect(audit.log).toHaveBeenCalledWith(
        'op', 'credit.bureau.create', 'credit_bureau_check', 'c1',
        expect.objectContaining({ band: 'veto' }), expect.any(String),
      )
    })

    it('usa la banda explícita si se pasa', async () => {
      profileRead.findOne.mockResolvedValue(withConsent)
      const check = await service.createManualCheck('b1', { band: 'clear' }, 'op')
      expect(check.band).toBe('clear')
    })

    it('rechaza si no hay rawScore ni band (400)', async () => {
      profileRead.findOne.mockResolvedValue(withConsent)
      await expect(service.createManualCheck('b1', {}, 'op')).rejects.toMatchObject({ status: 400 })
    })
  })

  describe('getActiveBand', () => {
    it('devuelve la banda del check vigente', async () => {
      profileRead.findOne.mockResolvedValue(withConsent)
      checkRead.findOne.mockResolvedValue({ id: 'c9', band: 'high_risk' })
      expect(await service.getActiveBand('b1')).toEqual({ band: 'high_risk', checkId: 'c9' })
    })

    it('null si la marca no tiene documento', async () => {
      profileRead.findOne.mockResolvedValue(null)
      expect(await service.getActiveBand('b1')).toBeNull()
    })

    it('null si no hay check vigente', async () => {
      profileRead.findOne.mockResolvedValue(withConsent)
      checkRead.findOne.mockResolvedValue(null)
      expect(await service.getActiveBand('b1')).toBeNull()
    })
  })

  describe('grantConsent', () => {
    it('registra consentimiento y audita', async () => {
      profileWrite.findOne.mockResolvedValue({ id: 'p1', brandId: 'b1' })
      await service.grantConsent('b1', { version: 'v1', source: 'admin' }, 'op')
      const saved = profileWrite.save.mock.calls.at(-1)![0]
      expect(saved.consentGrantedAt).toBeInstanceOf(Date)
      expect(saved.consentVersion).toBe('v1')
      expect(audit.log).toHaveBeenCalled()
    })

    it('rechaza si no hay perfil (400)', async () => {
      profileWrite.findOne.mockResolvedValue(null)
      await expect(service.grantConsent('b1', { version: 'v1', source: 'admin' }, 'op')).rejects.toMatchObject({ status: 400 })
    })
  })
})
