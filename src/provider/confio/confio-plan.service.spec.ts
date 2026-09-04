import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { ConfioPlanService } from './confio-plan.service'
import { ConfioSubscriptionPlan } from '../entities/confioSubscriptionPlan.entity'
import { RequestException } from '../../shared/exception/request.exception'

const createMockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
})

const row = (over: Partial<ConfioSubscriptionPlan> = {}): ConfioSubscriptionPlan =>
  ({
    id: 'row-1',
    planSlug: 'dropi-roax',
    currencyCode: 'COP',
    displayName: 'ROAX Pro (Dropi) - Mensual COP',
    amountCents: 1990000,
    confioName: 'stores/01STORE/subscription-plans/01PLAN',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }) as ConfioSubscriptionPlan

describe('ConfioPlanService', () => {
  let service: ConfioPlanService
  let repo: ReturnType<typeof createMockRepo>

  beforeEach(async () => {
    repo = createMockRepo()
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConfioPlanService,
        { provide: getRepositoryToken(ConfioSubscriptionPlan, 'DBRead'), useValue: repo },
      ],
    }).compile()

    service = module.get<ConfioPlanService>(ConfioPlanService)
  })

  describe('resolveConfioPlanName', () => {
    it('devuelve el resource name sembrado para (dropi-roax, COP)', async () => {
      repo.findOne.mockResolvedValue(row())

      await expect(service.resolveConfioPlanName('dropi-roax', 'COP')).resolves.toBe(
        'stores/01STORE/subscription-plans/01PLAN',
      )
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { planSlug: 'dropi-roax', currencyCode: 'COP' },
      })
    })

    it('normaliza la moneda a mayúsculas antes de buscar', async () => {
      repo.findOne.mockResolvedValue(row())

      await expect(service.resolveConfioPlanName('dropi-roax', 'cop')).resolves.toBe(
        'stores/01STORE/subscription-plans/01PLAN',
      )
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { planSlug: 'dropi-roax', currencyCode: 'COP' },
      })
    })

    it('falla explícitamente nombrando plan y moneda cuando la moneda no está mapeada', async () => {
      repo.findOne.mockResolvedValue(null)

      const err = await service.resolveConfioPlanName('dropi-roax', 'MXN').catch((e) => e)
      expect(err).toBeInstanceOf(RequestException)
      expect(err.code).toBe('CONFIO_PLAN_NOT_MAPPED')
      expect(err.getResponse().message).toContain('dropi-roax')
      expect(err.getResponse().message).toContain('MXN')
    })

    /**
     * Modo de fallo AGREGADO A PROPÓSITO, más allá de la aceptación: la fila
     * existe pero el plan todavía no fue creado en ConfioPagos. No es el caso
     * "moneda sin mapear" y por eso lleva otro código: confundirlos mandaría a
     * sembrar una fila que ya está.
     */
    it('[agregado] falla con un código DISTINTO si la fila existe pero el plan no fue creado en ConfioPagos', async () => {
      repo.findOne.mockResolvedValue(row({ confioName: null, status: 'pending' }))

      const err = await service.resolveConfioPlanName('dropi-roax', 'COP').catch((e) => e)
      expect(err).toBeInstanceOf(RequestException)
      expect(err.code).toBe('CONFIO_PLAN_NOT_CREATED')
      expect(err.code).not.toBe('CONFIO_PLAN_NOT_MAPPED')
      expect(err.getResponse().message).toMatch(/ConfioPagos/)
    })

    it('[agregado] falla si el mapeo está archivado, aunque tenga confioName', async () => {
      repo.findOne.mockResolvedValue(row({ status: 'archived' }))

      const err = await service.resolveConfioPlanName('dropi-roax', 'COP').catch((e) => e)
      expect(err).toBeInstanceOf(RequestException)
      expect(err.code).toBe('CONFIO_PLAN_ARCHIVED')
    })
  })
})
