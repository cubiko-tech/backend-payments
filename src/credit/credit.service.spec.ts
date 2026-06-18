import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'

import { CreditService } from './credit.service'
import { CreditScore } from './entities/creditScore.entity'
import { CreditInputsClient, CreditInputs } from './client/credit-inputs.client'
import { ScaleConfigService } from './scale-config.service'
import { SCALE_CONFIG_V1 } from './domain/scale-config.v1'

/** Período de 3 meses cerrados, válido respecto de hoy (mar–may 2026). */
const PERIOD = { periodStart: '2026-03-01', periodEnd: '2026-06-01' }

function inputs(overrides: Partial<CreditInputs> = {}): CreditInputs {
  return {
    brandId: 'brand-1',
    currency: 'COP',
    adSpend: 30_000_000, // 3 meses → 10M/mes (sInv 85)
    revenueMeta: 0, // informativo (Meta billing); el ROAS NO lo usa
    salesDelivered: 120_000_000, // 40M/mes (sVent 88) y ROAS real = 120M/30M = 4.0 → sRoas 80
    salesCurrencies: ['COP'],
    coverage: { metaFirstDataAt: '2025-12-01T05:00:00.000Z', dropiFirstDataAt: '2025-12-01T05:00:00.000Z', adAccountCreatedAt: null },
    fxToBase: { currency: 'COP', rate: 1, rateDate: null },
    ...overrides,
  }
}

describe('CreditService.calculate', () => {
  let service: CreditService
  let client: { getBatch: jest.Mock }
  let scaleConfig: { getActiveConfig: jest.Mock }

  beforeEach(async () => {
    client = { getBatch: jest.fn() }
    scaleConfig = {
      getActiveConfig: jest.fn().mockResolvedValue({ config: SCALE_CONFIG_V1, version: 1 }),
    }

    const repoMock = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve({ id: 'score-1', ...data })),
      findOne: jest.fn(),
      find: jest.fn(),
    }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditService,
        { provide: getRepositoryToken(CreditScore, 'DBWrite'), useValue: repoMock },
        { provide: getRepositoryToken(CreditScore, 'DBRead'), useValue: repoMock },
        { provide: CreditInputsClient, useValue: client },
        { provide: ScaleConfigService, useValue: scaleConfig },
      ],
    }).compile()

    service = module.get(CreditService)
  })

  const run = (i: CreditInputs) => {
    client.getBatch.mockResolvedValue([i])
    return service.calculate({ ...PERIOD, brandId: 'brand-1', triggeredBy: 'test' })
  }

  it('marca scored y bureau_pending sin check de buró', async () => {
    const s = await run(inputs())
    expect(s.scoreStatus).toBe('scored')
    expect(s.eligibilityStatus).toBe('bureau_pending')
    // sInv 85*.4 + sRoas 80*.4 + sVent 88*.2 = 34+32+17.6 = 83.6 → 84 → Pro Marketer.
    expect(s.total).toBe(84)
    expect(s.tier).toBe('pro_marketer')
    expect(s.periodAdjusted).toBe(false)
  })

  it('fx_unavailable cuando falta la tasa y la moneda no es la base', async () => {
    const s = await run(inputs({ currency: 'MXN', fxToBase: { currency: 'COP', rate: null, rateDate: null } }))
    expect(s.scoreStatus).toBe('fx_unavailable')
    expect(s.eligibilityStatus).toBe('not_applicable')
    expect(s.inputs.adSpend.converted).toBeNull()
  })

  it('convierte a moneda base con la tasa del período', async () => {
    const s = await run(
      inputs({ currency: 'USD', adSpend: 7_500, revenueMeta: 30_000, salesDelivered: 30_000, salesCurrencies: ['USD'], fxToBase: { currency: 'COP', rate: 4_000, rateDate: '2026-06-10' } }),
    )
    expect(s.inputs.adSpend.fxRate).toBe(4_000)
    expect(s.inputs.adSpend.converted).toBe(30_000_000) // 7500 USD * 4000
    expect(s.scoreStatus).toBe('scored')
  })

  it('insufficient_data cuando la cuenta es más nueva que 1 mes completo del período', async () => {
    const s = await run(inputs({ coverage: { metaFirstDataAt: '2026-05-20T05:00:00.000Z', dropiFirstDataAt: '2026-05-20T05:00:00.000Z', adAccountCreatedAt: null } }))
    expect(s.scoreStatus).toBe('insufficient_data')
    expect(s.eligibilityStatus).toBe('not_applicable')
  })

  it('period_adjusted cuando la cuenta arranca dentro del período', async () => {
    const s = await run(inputs({ coverage: { metaFirstDataAt: '2026-04-10T05:00:00.000Z', dropiFirstDataAt: '2026-04-10T05:00:00.000Z', adAccountCreatedAt: null } }))
    expect(s.periodAdjusted).toBe(true)
    expect(s.effectiveStart).toBe('2026-05-01') // abril incompleto → primer mes completo mayo
  })

  it('vetoed_roas cuando no hay inversión (spend 0)', async () => {
    const s = await run(inputs({ adSpend: 0, revenueMeta: 0 }))
    expect(s.scoreStatus).toBe('vetoed_roas')
    expect(s.eligibilityStatus).toBe('not_applicable')
    expect(s.tier).toBe('no_eligible')
  })

  it('vetoed_roas cuando el ROAS real (entregado/spend) < 3.0', async () => {
    // ROAS real = salesDelivered / adSpend = 84M / 30M = 2.8 → veto duro.
    const s = await run(inputs({ adSpend: 30_000_000, salesDelivered: 84_000_000 }))
    expect(s.subscores.roasValue).toBeCloseTo(2.8, 5)
    expect(s.scoreStatus).toBe('vetoed_roas')
    expect(s.tier).toBe('no_eligible')
  })
})
