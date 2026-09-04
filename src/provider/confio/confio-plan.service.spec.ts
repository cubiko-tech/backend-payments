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
    withTrial: true,
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

      await expect(service.resolveConfioPlanName('dropi-roax', 'COP', true)).resolves.toBe(
        'stores/01STORE/subscription-plans/01PLAN',
      )
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { planSlug: 'dropi-roax', currencyCode: 'COP', withTrial: true },
      })
    })

    it('normaliza la moneda a mayúsculas antes de buscar', async () => {
      repo.findOne.mockResolvedValue(row())

      await expect(service.resolveConfioPlanName('dropi-roax', 'cop', true)).resolves.toBe(
        'stores/01STORE/subscription-plans/01PLAN',
      )
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { planSlug: 'dropi-roax', currencyCode: 'COP', withTrial: true },
      })
    })

    it('falla explícitamente nombrando plan y moneda cuando la moneda no está mapeada', async () => {
      repo.findOne.mockResolvedValue(null)

      const err = await service.resolveConfioPlanName('dropi-roax', 'MXN', true).catch((e) => e)
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

      const err = await service.resolveConfioPlanName('dropi-roax', 'COP', true).catch((e) => e)
      expect(err).toBeInstanceOf(RequestException)
      expect(err.code).toBe('CONFIO_PLAN_NOT_CREATED')
      expect(err.code).not.toBe('CONFIO_PLAN_NOT_MAPPED')
      expect(err.getResponse().message).toMatch(/ConfioPagos/)
    })

    it('[agregado] falla si el mapeo está archivado, aunque tenga confioName', async () => {
      repo.findOne.mockResolvedValue(row({ status: 'archived' }))

      const err = await service.resolveConfioPlanName('dropi-roax', 'COP', true).catch((e) => e)
      expect(err).toBeInstanceOf(RequestException)
      expect(err.code).toBe('CONFIO_PLAN_ARCHIVED')
    })

    /**
     * La razón de existir de la dimensión: cada variante resuelve a un plan
     * DISTINTO de ConfioPagos, porque allá el período de prueba se congela en el
     * plan y no se puede pedir al crear la suscripción.
     */
    it('resuelve un plan distinto para el alta SIN prueba', async () => {
      repo.findOne.mockResolvedValue(
        row({
          id: 'row-2',
          withTrial: false,
          displayName: 'ROAX Pro (Dropi) - Mensual COP sin prueba',
          confioName: 'stores/01STORE/subscription-plans/01PLANPAGO',
        }),
      )

      await expect(service.resolveConfioPlanName('dropi-roax', 'COP', false)).resolves.toBe(
        'stores/01STORE/subscription-plans/01PLANPAGO',
      )
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { planSlug: 'dropi-roax', currencyCode: 'COP', withTrial: false },
      })
    })

    /**
     * EL CASO CARO. Con el plan sin prueba todavía sin sembrar, el alta paga tiene
     * que fallar ruidosamente y NO caer al plan con prueba: caer ahí le regala
     * quince días a quien ya los gastó, y ConfioPagos después los cobra.
     *
     * El repositorio se simula por CONTENIDO del `where` —devuelve la fila sólo si
     * se le pidió la variante con prueba— justamente para que una implementación
     * que ignore `withTrial` encuentre la fila de prueba y este test se ponga rojo.
     */
    it('[R15] no cae al plan CON prueba cuando falta el mapeo sin prueba', async () => {
      repo.findOne.mockImplementation(({ where }: { where: { withTrial: boolean } }) =>
        Promise.resolve(where.withTrial ? row() : null),
      )

      const err = await service.resolveConfioPlanName('dropi-roax', 'COP', false).catch((e) => e)
      expect(err).toBeInstanceOf(RequestException)
      expect(err.code).toBe('CONFIO_PLAN_NOT_MAPPED')
      // Y el mensaje dice CUÁL falta: sin esto manda a mirar una fila que sí existe.
      expect(err.getResponse().message).toContain('sin prueba')
    })

    it('[R15] tampoco resuelve la variante con prueba cuando sólo existe la paga', async () => {
      repo.findOne.mockImplementation(({ where }: { where: { withTrial: boolean } }) =>
        Promise.resolve(
          where.withTrial
            ? null
            : row({ withTrial: false, confioName: 'stores/01STORE/subscription-plans/01PLANPAGO' }),
        ),
      )

      const err = await service.resolveConfioPlanName('dropi-roax', 'COP', true).catch((e) => e)
      expect(err.code).toBe('CONFIO_PLAN_NOT_MAPPED')
      expect(err.getResponse().message).toContain('con prueba')
    })
  })
})
