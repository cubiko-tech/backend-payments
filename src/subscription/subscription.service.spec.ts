import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm'
import { SubscriptionService } from './subscription.service'
import { Subscription, SubscriptionStatus, SubscriptionProvider } from './entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from './entities/subscriptionEvent.entity'
import { ClientRolesService } from '../client/client-roles.service'
import { EventBusService } from '../event-bus/event-bus.service'
import { ConfioTrialService } from './confio-trial.service'
import { ConfioCancellationService } from './confio-cancellation.service'
import { RequestException } from '../shared/exception/request.exception'

/** Resource name completo de la suscripción del lado de ConfioPagos. */
const CONFIO_NAME = 'stores/store-1/subscription-plans/plan-1/subscriptions/sub-conf-1'

/**
 * Link PORTADOR de aceptación: se devuelve al llamador y no puede quedar
 * persistido en ninguna escritura.
 */
const ACCEPTANCE_URL = 'https://pay.dev.confiopagos.com/accept/abc123'

/** Lo que devuelve el alta real: `PENDING_ACCEPTANCE`, sin período abierto. */
const ALTA_CONFIO = {
  providerSubscriptionId: CONFIO_NAME,
  status: 'PENDING_ACCEPTANCE',
  acceptanceUrl: ACCEPTANCE_URL,
  acceptanceExpireTime: new Date('2026-09-02T00:00:00.000Z'),
  raw: { name: CONFIO_NAME, status: 'PENDING_ACCEPTANCE' },
}

const createMockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn((data) => data),
  save: jest.fn((data) => Promise.resolve({ id: 'mock-id', ...data })),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
})

const mockQueryRunner = {
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: {
    findOne: jest.fn(),
    save: jest.fn((entity, data) => Promise.resolve({ id: 'mock-id', ...data })),
    create: jest.fn((entity, data) => data),
  },
}

describe('SubscriptionService', () => {
  let service: SubscriptionService
  let subscriptionRepo: ReturnType<typeof createMockRepo>
  let subscriptionReadRepo: ReturnType<typeof createMockRepo>
  let eventRepo: ReturnType<typeof createMockRepo>
  let eventReadRepo: ReturnType<typeof createMockRepo>
  let clientRoles: { assignPlanToBrand: jest.Mock; removePlanFromBrand: jest.Mock; renewPlanForBrand: jest.Mock }
  let confioTrial: { createForTrial: jest.Mock; fetchAcceptance: jest.Mock }
  let confioCancellation: { cancel: jest.Mock }
  let eventBus: { publishNotification: jest.Mock }
  /**
   * EntityManager de la transacción del alta. Tiene `findOne` PROPIO —y no el del
   * repo— justamente para poder devolver algo DISTINTO de la pre-guardia: sin eso
   * los casos de carrera no probarían nada. `save` delega en los repos falsos para
   * que las aserciones existentes sigan valiendo.
   */
  let txManager: { findOne: jest.Mock; save: jest.Mock; exists: jest.Mock }

  beforeEach(async () => {
    subscriptionRepo = createMockRepo()
    subscriptionReadRepo = createMockRepo()
    eventRepo = createMockRepo()
    eventReadRepo = createMockRepo()

    txManager = {
      // Por defecto ve lo MISMO que la pre-guardia; los tests de carrera lo pisan.
      findOne: jest.fn(() => subscriptionRepo.findOne()),
      save: jest.fn((entity, data) =>
        entity === Subscription ? subscriptionRepo.save(data) : eventRepo.save(data),
      ),
      // Predicado de idempotencia de la baja: «¿esta fila YA tiene su
      // `SubscriptionEvent` CANCELLED?». Por defecto NO, que es el caso de una
      // baja nueva y también el de la fila a reparar.
      exists: jest.fn().mockResolvedValue(false),
    }

    Object.values(mockQueryRunner).forEach((fn) => {
      if (typeof fn === 'function') (fn as jest.Mock).mockReset()
    })
    mockQueryRunner.manager.findOne.mockReset()
    mockQueryRunner.manager.save.mockReset().mockImplementation((entity, data) =>
      Promise.resolve({ id: 'mock-id', ...data }),
    )
    mockQueryRunner.manager.create.mockReset().mockImplementation((entity, data) => data)

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: subscriptionRepo },
        { provide: getRepositoryToken(Subscription, 'DBRead'), useValue: subscriptionReadRepo },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), useValue: eventRepo },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBRead'), useValue: eventReadRepo },
        {
          provide: getDataSourceToken('DBWrite'),
          useValue: {
            createQueryRunner: () => mockQueryRunner,
            transaction: jest.fn((cb: any) => cb(txManager)),
          },
        },
        {
          provide: ConfioTrialService,
          useValue: {
            createForTrial: jest.fn().mockResolvedValue(ALTA_CONFIO),
            fetchAcceptance: jest.fn().mockResolvedValue({
              acceptanceUrl: ACCEPTANCE_URL,
              status: 'PENDING_ACCEPTANCE',
              acceptanceExpireTime: ALTA_CONFIO.acceptanceExpireTime,
            }),
          },
        },
        {
          provide: ConfioCancellationService,
          useValue: { cancel: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: ClientRolesService,
          useValue: {
            assignPlanToBrand: jest.fn().mockResolvedValue(true),
            removePlanFromBrand: jest.fn().mockResolvedValue(true),
            renewPlanForBrand: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: EventBusService,
          useValue: { publishNotification: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile()

    service = module.get<SubscriptionService>(SubscriptionService)
    clientRoles = module.get(ClientRolesService)
    confioTrial = module.get(ConfioTrialService)
    confioCancellation = module.get(ConfioCancellationService)
    eventBus = module.get(EventBusService)
  })

  describe('getCurrent', () => {
    it('retorna la suscripción actual de una marca', async () => {
      const subscription = {
        id: 'sub-1',
        brandId: 'brand-1',
        planSlug: 'pro',
        status: SubscriptionStatus.ACTIVE,
      }
      subscriptionReadRepo.findOne.mockResolvedValue(subscription)

      const result = await service.getCurrent('brand-1')

      expect(result.data).toEqual(subscription)
      expect(subscriptionReadRepo.findOne).toHaveBeenCalledWith({
        where: { brandId: 'brand-1' },
      })
    })

    it('lanza error si no existe suscripción', async () => {
      subscriptionReadRepo.findOne.mockResolvedValue(null)

      await expect(service.getCurrent('brand-1')).rejects.toThrow(RequestException)
    })
  })

  describe('create', () => {
    it('crea suscripción y registra evento de creación', async () => {
      const data = {
        brandId: 'brand-1',
        userId: 'user-1',
        planSlug: 'pro',
        status: SubscriptionStatus.TRIAL,
      }
      subscriptionRepo.create.mockReturnValue(data)
      subscriptionRepo.save.mockResolvedValue({ id: 'sub-1', ...data })
      eventRepo.create.mockReturnValue({
        subscriptionId: 'sub-1',
        eventType: SubscriptionEventType.CREATED,
      })
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.create(data)

      expect(result.data).toEqual({ id: 'sub-1', ...data })
      expect(subscriptionRepo.create).toHaveBeenCalledWith(data)
      expect(subscriptionRepo.save).toHaveBeenCalledWith(data)

      // Verifica que se registró el evento
      expect(eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionId: 'sub-1',
        eventType: SubscriptionEventType.CREATED,
        toPlanSlug: 'pro',
        toStatus: SubscriptionStatus.TRIAL,
        triggeredBy: 'user-1',
      }))
      expect(eventRepo.save).toHaveBeenCalled()
    })
  })

  describe('startTrial', () => {
    it('crea un trial de 15 días, asigna el plan en roles y registra el evento', async () => {
      subscriptionRepo.findOne.mockResolvedValue(null)
      subscriptionRepo.create.mockImplementation((data) => data)
      subscriptionRepo.save.mockImplementation((data) => Promise.resolve({ id: 'sub-1', ...data }))
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro' })

      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)
      expect(result.data.trialStart).toBeInstanceOf(Date)
      expect(result.data.trialEnd).toBeInstanceOf(Date)
      // nextBillingDate = trialEnd para que el cron de conversión lo tome
      expect(result.data.nextBillingDate).toEqual(result.data.trialEnd)
      // ~15 días de trial
      const days = Math.round(
        (result.data.trialEnd.getTime() - result.data.trialStart.getTime()) / (24 * 3600 * 1000),
      )
      expect(days).toBe(15)

      // plan asignado en roles con expiración = fin del trial
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('brand-1', 'pro', result.data.trialEnd)

      expect(eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionId: 'sub-1',
        eventType: SubscriptionEventType.TRIAL_STARTED,
        toPlanSlug: 'pro',
        toStatus: SubscriptionStatus.TRIAL,
        triggeredBy: 'user-1',
      }))
    })

    it('rechaza si la marca ya tiene una suscripción vigente', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.ACTIVE,
        trialStart: null,
      })

      await expect(
        service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro' }),
      ).rejects.toMatchObject({ code: 'SUBSCRIPTION_ALREADY_EXISTS' })
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
    })

    it('rechaza una suscripción en mora como vigente, no como prueba consumida', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.PAST_DUE,
        trialStart: new Date('2026-01-01'),
      })

      await expect(
        service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro' }),
      ).rejects.toMatchObject({ code: 'SUBSCRIPTION_ALREADY_EXISTS' })
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
    })

    it('rechaza si la marca ya consumió su prueba', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.EXPIRED,
        trialStart: new Date('2026-01-01'),
        trialEnd: new Date('2026-01-16'),
      })

      await expect(
        service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro' }),
      ).rejects.toMatchObject({ code: 'TRIAL_ALREADY_USED' })
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
    })

    it('reinicia la prueba sobre una suscripción cancelada que nunca la usó', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.CANCELLED,
        trialStart: null,
        cancelledAt: new Date('2026-02-01'),
        cancelReason: 'motivo',
        retryCount: 3,
        lastPaymentId: 'pay-1',
      })
      subscriptionRepo.create.mockImplementation((data) => data)
      subscriptionRepo.save.mockImplementation((data) => Promise.resolve({ ...data }))
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.startTrial({
        brandId: 'brand-1',
        userId: 'user-1',
        planSlug: 'pro',
      })

      // Reusa la fila existente: el índice único por brandId impide una segunda.
      expect(subscriptionRepo.save).toHaveBeenCalledWith(expect.objectContaining({
        id: 'sub-1',
        status: SubscriptionStatus.TRIAL,
        cancelledAt: null,
        cancelReason: null,
        retryCount: 0,
        lastPaymentId: null,
      }))
      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('brand-1', 'pro', result.data.trialEnd)
      expect(eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: SubscriptionEventType.TRIAL_STARTED,
        fromStatus: SubscriptionStatus.CANCELLED,
        toStatus: SubscriptionStatus.TRIAL,
      }))
    })

    it('permite la prueba sobre una suscripción vencida que nunca la usó', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.EXPIRED,
        trialStart: null,
      })
      subscriptionRepo.create.mockImplementation((data) => data)
      subscriptionRepo.save.mockImplementation((data) => Promise.resolve({ ...data }))
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.startTrial({
        brandId: 'brand-1',
        userId: 'user-1',
        planSlug: 'pro',
      })

      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)
      expect(subscriptionRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-1' }))
    })

    it('rechaza iniciar un trial con el plan free', async () => {
      await expect(
        service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'free' }),
      ).rejects.toThrow(RequestException)
    })
  })

  describe('startTrial — alta contra ConfioPagos', () => {
    const alta = (extra: Record<string, any> = {}) =>
      service.startTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'dropi-roax', ...extra })

    it('devuelve el link de aceptación y guarda el `name`, nunca el link', async () => {
      const result = await alta()

      expect(result.acceptanceUrl).toBe(ACCEPTANCE_URL)
      expect(result.acceptanceExpireTime).toEqual(ALTA_CONFIO.acceptanceExpireTime)
      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)

      expect(subscriptionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'confio',
          providerSubscriptionId: CONFIO_NAME,
          metadata: expect.objectContaining({
            confio: expect.objectContaining({ name: CONFIO_NAME, status: 'PENDING_ACCEPTANCE' }),
          }),
        }),
      )

      // NINGUNA escritura puede llevar el link portador.
      const escrito =
        JSON.stringify(subscriptionRepo.save.mock.calls) + JSON.stringify(eventRepo.save.mock.calls)
      expect(escrito).not.toContain(ACCEPTANCE_URL)
    })

    it('marca `initialPaymentLinkIssuedAt` en la MISMA transacción que crea la fila', async () => {
      await alta()

      // La PRIMERA escritura de `Subscription` de la transacción: el marcador nace con la
      // fila, no en un `save` posterior al commit.
      const [, data] = txManager.save.mock.calls.find(([entity]) => entity === Subscription)
      expect(data).toEqual(
        expect.objectContaining({
          trialStart: expect.any(Date),
          initialPaymentLinkIssuedAt: expect.any(Date),
        }),
      )
    })

    it('el reuso de una fila muerta también queda marcado (ciclo nuevo, link nuevo)', async () => {
      const muerta = {
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.EXPIRED,
        trialStart: null,
      }
      subscriptionRepo.findOne.mockResolvedValue(muerta)
      txManager.findOne.mockResolvedValue(muerta)

      await alta()

      const [, data] = txManager.save.mock.calls.find(([entity]) => entity === Subscription)
      expect(data).toEqual(
        expect.objectContaining({ id: 'sub-1', initialPaymentLinkIssuedAt: expect.any(Date) }),
      )
    })

    it('escribe DESPUÉS de tener el link: Confío → roles → fila', async () => {
      await alta()

      const confioAt = confioTrial.createForTrial.mock.invocationCallOrder[0]
      const rolesAt = clientRoles.assignPlanToBrand.mock.invocationCallOrder[0]
      const saveAt = subscriptionRepo.save.mock.invocationCallOrder[0]

      expect(confioAt).toBeLessThan(rolesAt)
      expect(rolesAt).toBeLessThan(saveAt)
    })

    it('Confío caído NO quema la marca: cero escrituras y el reintento crea el trial', async () => {
      confioTrial.createForTrial.mockRejectedValueOnce(
        new RequestException({ code: 'CONFIO_SUBSCRIPTION_UNAVAILABLE', message: 'x' }, 503),
      )

      await expect(alta()).rejects.toMatchObject({ code: 'CONFIO_SUBSCRIPTION_UNAVAILABLE' })
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
      expect(eventRepo.save).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()

      // Mismo `findOne`, Confío sano: la prueba sigue disponible.
      const result = await alta()
      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)
      expect(result.acceptanceUrl).toBe(ACCEPTANCE_URL)
    })

    it('`assignPlanToBrand` que RESUELVE false (no rechaza) → 503 y cero escrituras', async () => {
      clientRoles.assignPlanToBrand.mockResolvedValue(false)

      await expect(alta()).rejects.toMatchObject({ code: 'PLAN_ASSIGNMENT_FAILED' })
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
      expect(eventRepo.save).not.toHaveBeenCalled()
    })

    it('carrera sobre fila muerta: bajo el lock ya tiene `trialStart` → 409 sin pisarla', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.EXPIRED,
        trialStart: null,
      })
      txManager.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.EXPIRED,
        trialStart: new Date('2026-08-26'),
      })

      await expect(alta()).rejects.toMatchObject({ code: 'TRIAL_ALREADY_USED' })
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
    })

    it('carrera sobre fila muerta: bajo el lock ya está en trial → 409 SUBSCRIPTION_ALREADY_EXISTS', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.CANCELLED,
        trialStart: null,
      })
      txManager.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.TRIAL,
        trialStart: new Date('2026-08-26'),
      })

      await expect(alta()).rejects.toMatchObject({ code: 'SUBSCRIPTION_ALREADY_EXISTS' })
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
    })

    it('carrera sobre marca nueva: el 23505 del índice único es un 409, no un 500', async () => {
      subscriptionRepo.save.mockRejectedValue(
        Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
      )

      await expect(alta()).rejects.toMatchObject({ code: 'SUBSCRIPTION_ALREADY_EXISTS' })
    })

    it('manda `correlationId` sólo cuando reusa una fila (ahí el id es estable entre reintentos)', async () => {
      subscriptionRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        status: SubscriptionStatus.EXPIRED,
        trialStart: null,
      })

      await alta()

      expect(confioTrial.createForTrial).toHaveBeenCalledWith(
        expect.objectContaining({ correlationId: 'sub-1' }),
      )
    })

    it('marca nueva: la CLAVE `correlationId` no existe (no se pre-genera un uuid por intento)', async () => {
      await alta()

      const params = confioTrial.createForTrial.mock.calls[0][0]
      expect(Object.keys(params)).not.toContain('correlationId')
    })

    it.each([
      ['provider distinto de confio', { provider: 'wallet' }],
      ['walletId presente', { walletId: 'wal-1' }],
    ])('%s → 422 ruidoso y CERO llamadas a ConfioPagos', async (_caso, extra) => {
      await expect(alta(extra)).rejects.toMatchObject({ code: 'TRIAL_PROVIDER_NOT_SUPPORTED' })
      expect(confioTrial.createForTrial).not.toHaveBeenCalled()
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
    })

    it('una notificación que explota DESPUÉS del commit no degrada un alta exitosa', async () => {
      eventBus.publishNotification.mockRejectedValue(new Error('redis caído'))

      const result = await alta()

      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)
      expect(result.acceptanceUrl).toBe(ACCEPTANCE_URL)
      expect((result as any).error).toBeUndefined()
    })

    // El `catch` de la notificación existe para AISLAR: si él mismo explota leyendo
    // `.message` de algo que no es un `Error`, la excepción sube al `try` de afuera y
    // degrada a `{ error }` un alta YA COMMITEADA — justo lo contrario de aislar.
    it('un rechazo que NO es Error tampoco degrada el alta commiteada', async () => {
      eventBus.publishNotification.mockRejectedValue(undefined)

      const result = await alta()

      expect(result.data.status).toBe(SubscriptionStatus.TRIAL)
      expect(result.acceptanceUrl).toBe(ACCEPTANCE_URL)
      expect((result as any).error).toBeUndefined()
    })

    // Un 200 sin `acceptanceUrl` es INDISTINGUIBLE de un éxito para un front que hace
    // `res.acceptanceUrl`: el contrato entero de este endpoint es devolver el link.
    it('un fallo inesperado NO devuelve 200 con `{ error }`: es 503 TRIAL_START_FAILED', async () => {
      subscriptionRepo.save.mockRejectedValue(new Error('connection terminated unexpectedly'))

      const error = await alta().catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('TRIAL_START_FAILED')
      expect(error.getStatus()).toBe(503)
      // El detalle del fallo interno no se reexpone.
      expect(JSON.stringify(error.getResponse())).not.toContain('connection terminated')
    })

    it('un `name` sin `/subscriptions/` guarda `planName: null`, no el recurso entero', async () => {
      confioTrial.createForTrial.mockResolvedValue({ ...ALTA_CONFIO, providerSubscriptionId: 'raro-sin-separador' })

      await alta()

      expect(subscriptionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ confio: expect.objectContaining({ planName: null }) }),
        }),
      )
    })

    // La fila que se REUSA es la del lock (`current`), no la de la pre-guardia: si la
    // pre-guardia no vio nada y bajo el lock apareció una fila muerta, el
    // `correlationId` tiene que ser el id de ESA fila.
    it('carrera: la pre-guardia no vio fila pero el lock sí → `correlationId` es el id lockeado', async () => {
      subscriptionRepo.findOne.mockResolvedValue(null)
      txManager.findOne.mockResolvedValue({
        id: 'sub-lockeada',
        brandId: 'brand-1',
        status: SubscriptionStatus.EXPIRED,
        trialStart: null,
      })

      await alta()

      expect(subscriptionRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'sub-lockeada',
          metadata: expect.objectContaining({
            confio: expect.objectContaining({ correlationId: 'sub-lockeada' }),
          }),
        }),
      )
    })
  })

  describe('getAcceptanceLink', () => {
    it('re-pide el link a partir del `name` guardado en metadata', async () => {
      subscriptionReadRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        providerSubscriptionId: 'viejo',
        metadata: { confio: { name: CONFIO_NAME } },
      })

      const result = await service.getAcceptanceLink('brand-1')

      expect(confioTrial.fetchAcceptance).toHaveBeenCalledWith(CONFIO_NAME)
      expect(result.data.acceptanceUrl).toBe(ACCEPTANCE_URL)
    })

    it('cae a `providerSubscriptionId` cuando la metadata no lo tiene', async () => {
      subscriptionReadRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        providerSubscriptionId: CONFIO_NAME,
        metadata: null,
      })

      await service.getAcceptanceLink('brand-1')

      expect(confioTrial.fetchAcceptance).toHaveBeenCalledWith(CONFIO_NAME)
    })

    it('sin fila → 404 SUBSCRIPTION_NOT_FOUND', async () => {
      subscriptionReadRepo.findOne.mockResolvedValue(null)

      await expect(service.getAcceptanceLink('brand-1')).rejects.toMatchObject({
        code: 'SUBSCRIPTION_NOT_FOUND',
      })
      expect(confioTrial.fetchAcceptance).not.toHaveBeenCalled()
    })

    it('fila sin suscripción en ConfioPagos → 422 NO_CONFIO_SUBSCRIPTION', async () => {
      subscriptionReadRepo.findOne.mockResolvedValue({
        id: 'sub-1',
        brandId: 'brand-1',
        providerSubscriptionId: null,
        metadata: null,
      })

      await expect(service.getAcceptanceLink('brand-1')).rejects.toMatchObject({
        code: 'NO_CONFIO_SUBSCRIPTION',
      })
    })
  })

  describe('cancel', () => {
    /**
     * Fila de ConfioPagos tal cual la deja el alta: el `name` vive en
     * `metadata.confio.name` y `providerSubscriptionId` es el mismo valor.
     */
    const filaConfio = (over: Record<string, any> = {}): any => ({
      id: 'sub-1',
      brandId: 'brand-1',
      userId: 'user-1',
      planSlug: 'dropi-roax',
      provider: SubscriptionProvider.CONFIO,
      providerSubscriptionId: CONFIO_NAME,
      status: SubscriptionStatus.TRIAL,
      autoRenew: true,
      cancelledAt: null,
      cancelReason: null,
      metadata: { confio: { name: CONFIO_NAME } },
      ...over,
    })

    const bajaEscrita = () => ({
      filas: subscriptionRepo.save.mock.calls.length,
      eventos: eventRepo.save.mock.calls.length,
      roles: clientRoles.removePlanFromBrand.mock.calls.length,
    })

    it('cancela en ConfioPagos ANTES de escribir, y recién ahí sella la fila y el evento', async () => {
      const subscription = filaConfio()
      subscriptionRepo.findOne.mockResolvedValue(subscription)
      subscriptionRepo.save.mockResolvedValue(subscription)
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const orden: string[] = []
      confioCancellation.cancel.mockImplementation(async () => {
        orden.push('confio')
      })
      subscriptionRepo.save.mockImplementation(async (d: any) => {
        orden.push('save')
        return d
      })

      const result = await service.cancel('brand-1', {
        reason: 'Ya no necesito el servicio',
        triggeredBy: 'user-1',
      })

      // El `name` sale de metadata.confio, igual que en getAcceptanceLink.
      expect(confioCancellation.cancel).toHaveBeenCalledWith(CONFIO_NAME, 'Ya no necesito el servicio')
      // El ORDEN es la invariante: nada se escribe antes de que Confío confirme.
      expect(orden[0]).toBe('confio')
      expect(orden).toContain('save')

      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED)
      expect(subscription.autoRenew).toBe(false)
      expect(subscription.cancelledAt).toBeInstanceOf(Date)
      expect(subscription.cancelReason).toBe('Ya no necesito el servicio')

      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionId: 'sub-1',
          eventType: SubscriptionEventType.CANCELLED,
          fromStatus: SubscriptionStatus.TRIAL,
          toStatus: SubscriptionStatus.CANCELLED,
          triggeredBy: 'user-1',
          reason: 'Ya no necesito el servicio',
        }),
      )
      expect(clientRoles.removePlanFromBrand).toHaveBeenCalledWith('brand-1', 'dropi-roax')
      expect(result.data).toBeDefined()
    })

    it('la traza lleva marca, usuario, plan y la referencia de ConfioPagos, sin providerEventId', async () => {
      const subscription = filaConfio()
      subscriptionRepo.findOne.mockResolvedValue(subscription)
      subscriptionRepo.save.mockResolvedValue(subscription)
      eventRepo.create.mockImplementation((data) => data)

      await service.cancel('brand-1', { reason: 'baja voluntaria', triggeredBy: 'user-1' })

      const traza = eventRepo.create.mock.calls[0][0]
      expect(traza.metadata).toEqual(
        expect.objectContaining({
          event: 'subscription.cancel',
          brandId: 'brand-1',
          userId: 'user-1',
          planSlug: 'dropi-roax',
          confirmadoPorConfio: true,
          providerRef: { name: CONFIO_NAME },
        }),
      )
      // `providerEventId` es el predicado de idempotencia del WEBHOOK: escribirlo
      // acá haría que una notificación posterior se creyera ya aplicada.
      expect(traza.metadata).not.toHaveProperty('providerEventId')
    })

    /**
     * RESTRICCIÓN 1 de la aceptación: nunca escribir un hecho que ConfioPagos no
     * confirmó. Los dos rechazos de la pasarela propagan su `RequestException` y
     * dejan CERO escrituras — ni fila, ni evento, ni baja en roles.
     */
    it.each([
      ['CONFIO_SUBSCRIPTION_NAME_INVALID'],
      ['CONFIO_CANCEL_UNAVAILABLE'],
    ])('%s propaga tal cual y no escribe NADA', async (code) => {
      subscriptionRepo.findOne.mockResolvedValue(filaConfio())
      confioCancellation.cancel.mockRejectedValue(
        new RequestException({ code, message: 'no se pudo' }, 503),
      )

      const error = await service
        .cancel('brand-1', { reason: 'baja voluntaria', triggeredBy: 'user-1' })
        .catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe(code)
      expect(error.getStatus()).toBe(503)
      expect(bajaEscrita()).toEqual({ filas: 0, eventos: 0, roles: 0 })
    })

    /**
     * RESTRICCIÓN 5: camino de reparación. Una fila ya terminal (sin la traza) se
     * vuelve a cancelar en ConfioPagos —es idempotente, medido 2026-08-27— y esta
     * vez SÍ deja su `SubscriptionEvent`. El `cancelledAt` que ya estaba no se
     * re-sella, igual que hace el webhook.
     */
    it('repara una fila terminal: re-cancela en Confío y deja el evento sin re-sellar cancelledAt', async () => {
      const sello = new Date('2026-08-01T00:00:00.000Z')
      const subscription = filaConfio({
        status: SubscriptionStatus.EXPIRED,
        cancelledAt: sello,
        autoRenew: false,
      })
      // Lo que hace que esto sea REPARACIÓN y no repetición: falta la traza.
      txManager.exists.mockResolvedValue(false)
      subscriptionRepo.findOne.mockResolvedValue(subscription)
      subscriptionRepo.save.mockResolvedValue(subscription)
      eventRepo.create.mockImplementation((data) => data)

      await service.cancel('brand-1', { reason: 'reintento', triggeredBy: 'user-1' })

      expect(confioCancellation.cancel).toHaveBeenCalledWith(CONFIO_NAME, 'reintento')
      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED)
      expect(subscription.cancelledAt).toBe(sello)
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: SubscriptionEventType.CANCELLED,
          fromStatus: SubscriptionStatus.EXPIRED,
          toStatus: SubscriptionStatus.CANCELLED,
        }),
      )
    })

    it('un motivo en blanco es 422 CANCEL_REASON_REQUIRED, sin llamar a Confío ni escribir', async () => {
      subscriptionRepo.findOne.mockResolvedValue(filaConfio())

      const error = await service
        .cancel('brand-1', { reason: '   ', triggeredBy: 'user-1' })
        .catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('CANCEL_REASON_REQUIRED')
      expect(error.getStatus()).toBe(422)
      expect(confioCancellation.cancel).not.toHaveBeenCalled()
      expect(bajaEscrita()).toEqual({ filas: 0, eventos: 0, roles: 0 })
    })

    it('una fila que no es de ConfioPagos se cancela local y no habla con la pasarela', async () => {
      const subscription = filaConfio({
        provider: SubscriptionProvider.WALLET,
        providerSubscriptionId: null,
        metadata: null,
        status: SubscriptionStatus.ACTIVE,
      })
      subscriptionRepo.findOne.mockResolvedValue(subscription)
      subscriptionRepo.save.mockResolvedValue(subscription)
      eventRepo.create.mockImplementation((data) => data)

      const result = await service.cancel('brand-1', {
        reason: 'Ya no necesito el servicio',
        triggeredBy: 'user-1',
      })

      expect(confioCancellation.cancel).not.toHaveBeenCalled()
      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED)
      expect(subscription.autoRenew).toBe(false)
      expect(eventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: SubscriptionEventType.CANCELLED }),
      )
      expect(result.data).toBeDefined()
    })

    it('lanza error si la suscripción no existe', async () => {
      subscriptionRepo.findOne.mockResolvedValue(null)

      const error = await service
        .cancel('brand-1', { reason: 'test', triggeredBy: 'user-1' })
        .catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('SUBSCRIPTION_NOT_FOUND')
      expect(confioCancellation.cancel).not.toHaveBeenCalled()
    })

    /**
     * Antes esto devolvía `{ error }` con HTTP 200: un fallo de la escritura local
     * se leía como una baja exitosa. Ahora es 503 — y el reintento se auto-repara,
     * porque la cancelación de ConfioPagos es idempotente.
     */
    it('un fallo inesperado de la escritura es 503 SUBSCRIPTION_CANCEL_FAILED, no un 200 con {error}', async () => {
      subscriptionRepo.findOne.mockResolvedValue(filaConfio())
      subscriptionRepo.save.mockRejectedValue(new Error('deadlock detected'))

      const error = await service
        .cancel('brand-1', { reason: 'baja voluntaria', triggeredBy: 'user-1' })
        .catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('SUBSCRIPTION_CANCEL_FAILED')
      expect(error.getStatus()).toBe(503)
      // El detalle interno no se reexpone.
      expect(JSON.stringify(error.getResponse())).not.toContain('deadlock')
    })

    /**
     * IDEMPOTENCIA. Una fila YA sellada y CON su traza describe una baja ya
     * registrada: el doble click en «cancelar» —o el reintento del cliente
     * después de un 200 que se perdió— no puede duplicar el `SubscriptionEvent`
     * de la MISMA transición ni reescribir el motivo original. Es la otra mitad
     * de la restricción 5: reparar sí, repetir no.
     */
    it('una baja YA registrada no duplica la traza ni pisa el motivo original', async () => {
      const sello = new Date('2026-08-01T00:00:00.000Z')
      const subscription = filaConfio({
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: sello,
        cancelReason: 'motivo original',
        autoRenew: false,
      })
      subscriptionRepo.findOne.mockResolvedValue(subscription)
      subscriptionRepo.save.mockResolvedValue(subscription)
      txManager.exists.mockResolvedValue(true)

      await service.cancel('brand-1', { reason: 'segundo click', triggeredBy: 'user-1' })

      expect(txManager.exists).toHaveBeenCalledWith(SubscriptionEvent, {
        where: { subscriptionId: 'sub-1', eventType: SubscriptionEventType.CANCELLED },
      })
      expect(eventRepo.create).not.toHaveBeenCalled()
      expect(eventRepo.save).not.toHaveBeenCalled()
      expect(subscription.cancelReason).toBe('motivo original')
      expect(subscription.cancelledAt).toBe(sello)
      // Roles SÍ se vuelve a llamar: el reintento puede venir justo de que esta
      // llamada falló la primera vez, y saltearla dejaría el plan puesto.
      expect(clientRoles.removePlanFromBrand).toHaveBeenCalledWith('brand-1', 'dropi-roax')
    })

    /**
     * `triggeredBy` es `varchar NOT NULL` en `subscription_events` y el body de
     * este endpoint NO pasa por un DTO. Si no se valida ACÁ, la baja se hace de
     * verdad en ConfioPagos y recién después muere la escritura: cancelada allá,
     * viva acá, y el reintento muriendo igual para siempre.
     */
    it.each([
      ['ausente', 'CANCEL_TRIGGERED_BY_REQUIRED', undefined],
      ['en blanco', 'CANCEL_TRIGGERED_BY_REQUIRED', '   '],
      ['más largo que la columna', 'CANCEL_TRIGGERED_BY_TOO_LONG', 'u'.repeat(256)],
    ])('un triggeredBy %s es 422 %s ANTES de tocar ConfioPagos', async (_caso, code, valor) => {
      subscriptionRepo.findOne.mockResolvedValue(filaConfio())

      const error = await service
        .cancel('brand-1', { reason: 'baja voluntaria', triggeredBy: valor as any })
        .catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe(code)
      expect(error.getStatus()).toBe(422)
      expect(confioCancellation.cancel).not.toHaveBeenCalled()
      expect(bajaEscrita()).toEqual({ filas: 0, eventos: 0, roles: 0 })
    })

    it('un motivo más largo que el tope es 422 CANCEL_REASON_TOO_LONG, sin llamar a Confío', async () => {
      subscriptionRepo.findOne.mockResolvedValue(filaConfio())

      const error = await service
        .cancel('brand-1', { reason: 'x'.repeat(501), triggeredBy: 'user-1' })
        .catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('CANCEL_REASON_TOO_LONG')
      expect(error.getStatus()).toBe(422)
      expect(confioCancellation.cancel).not.toHaveBeenCalled()
      expect(bajaEscrita()).toEqual({ filas: 0, eventos: 0, roles: 0 })
    })

    /**
     * Fila `confio` SIN resource name: la que deja el checkout, que marca
     * `provider = confio` y nunca escribe el `name` (sólo `startTrial` lo hace).
     * Nunca hubo suscripción del otro lado, así que la baja es local — y es lo
     * ÚNICO que la saca del cron horario de re-emisión de cobro. Antes esto era
     * un 503 eterno con el cobro siguiendo su curso.
     */
    it('una fila confio SIN resource name se cancela local, sin hablar con la pasarela', async () => {
      const subscription = filaConfio({
        providerSubscriptionId: null,
        metadata: null,
        status: SubscriptionStatus.ACTIVE,
      })
      subscriptionRepo.findOne.mockResolvedValue(subscription)
      subscriptionRepo.save.mockResolvedValue(subscription)
      eventRepo.create.mockImplementation((data) => data)

      const result = await service.cancel('brand-1', {
        reason: 'baja voluntaria',
        triggeredBy: 'user-1',
      })

      expect(confioCancellation.cancel).not.toHaveBeenCalled()
      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED)
      // El cron horario filtra por `autoRenew`: esto es lo que corta el cobro.
      expect(subscription.autoRenew).toBe(false)
      const traza = eventRepo.create.mock.calls[0][0]
      expect(traza.metadata.confirmadoPorConfio).toBe(false)
      expect(traza.metadata).not.toHaveProperty('providerRef')
      expect(result.data).toBeDefined()
    })

    it('un name vacío en metadata no tapa el providerSubscriptionId bueno', async () => {
      subscriptionRepo.findOne.mockResolvedValue(filaConfio({ metadata: { confio: { name: '' } } }))
      eventRepo.create.mockImplementation((data) => data)

      await service.cancel('brand-1', { reason: 'baja voluntaria', triggeredBy: 'user-1' })

      expect(confioCancellation.cancel).toHaveBeenCalledWith(CONFIO_NAME, 'baja voluntaria')
    })

    /**
     * `metadata` es jsonb SIN tipar: un `name` que no es string está CORRUPTO, no
     * ausente. Va al borde del provider —que lo rechaza sin tocar la red— y sale
     * 503 con cero escrituras, porque del otro lado puede haber una suscripción
     * cobrando. Jamás se cancela local por las dudas.
     */
    it('un name corrupto (no string) va a la pasarela y termina en 503 sin escribir nada', async () => {
      subscriptionRepo.findOne.mockResolvedValue(
        filaConfio({ metadata: { confio: { name: { roto: true } } }, providerSubscriptionId: null }),
      )
      confioCancellation.cancel.mockRejectedValue(
        new RequestException({ code: 'CONFIO_SUBSCRIPTION_NAME_INVALID', message: 'no' }, 503),
      )

      const error = await service
        .cancel('brand-1', { reason: 'baja voluntaria', triggeredBy: 'user-1' })
        .catch((e) => e)

      expect(confioCancellation.cancel).toHaveBeenCalledWith({ roto: true }, 'baja voluntaria')
      expect(error.code).toBe('CONFIO_SUBSCRIPTION_NAME_INVALID')
      expect(bajaEscrita()).toEqual({ filas: 0, eventos: 0, roles: 0 })
    })

    /**
     * La relectura bajo lock existe porque entre la pre-lectura y la escritura
     * hubo una llamada HTTP. Acá se ejerce de verdad: la fila cambió de plan en
     * esa ventana y TODO —la traza y la baja en roles— sale de la fila releída.
     */
    it('usa la fila releída bajo lock, no la de la pre-lectura', async () => {
      subscriptionRepo.findOne.mockResolvedValue(filaConfio())
      const bajoLock = filaConfio({ planSlug: 'plan-nuevo', status: SubscriptionStatus.PAST_DUE })
      txManager.findOne.mockResolvedValue(bajoLock)
      subscriptionRepo.save.mockResolvedValue(bajoLock)
      eventRepo.create.mockImplementation((data) => data)

      await service.cancel('brand-1', { reason: 'baja voluntaria', triggeredBy: 'user-1' })

      const traza = eventRepo.create.mock.calls[0][0]
      expect(traza.fromStatus).toBe(SubscriptionStatus.PAST_DUE)
      expect(traza.metadata.planSlug).toBe('plan-nuevo')
      expect(clientRoles.removePlanFromBrand).toHaveBeenCalledWith('brand-1', 'plan-nuevo')
    })

    /**
     * Si la fila desapareció en la ventana de la llamada HTTP, `manager.save`
     * sobre el objeto detached la RE-INSERTARÍA: resurrección de datos borrados.
     */
    it('si la fila desapareció bajo lock, es 404 y no se re-inserta nada', async () => {
      subscriptionRepo.findOne.mockResolvedValue(filaConfio())
      txManager.findOne.mockResolvedValue(null)

      const error = await service
        .cancel('brand-1', { reason: 'baja voluntaria', triggeredBy: 'user-1' })
        .catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('SUBSCRIPTION_NOT_FOUND')
      expect(error.getStatus()).toBe(404)
      expect(bajaEscrita()).toEqual({ filas: 0, eventos: 0, roles: 0 })
    })
  })

  describe('reactivate', () => {
    it('reactiva una suscripción cancelada', async () => {
      const subscription = {
        id: 'sub-1',
        brandId: 'brand-1',
        provider: SubscriptionProvider.WALLET,
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: 'motivo',
        autoRenew: false,
      }
      subscriptionRepo.findOne.mockResolvedValue(subscription)
      subscriptionRepo.save.mockResolvedValue(subscription)
      eventRepo.create.mockImplementation((data) => data)
      eventRepo.save.mockResolvedValue({ id: 'ev-1' })

      const result = await service.reactivate('brand-1', 'user-1')

      expect(subscription.status).toBe(SubscriptionStatus.ACTIVE)
      expect(subscription.cancelledAt).toBeNull()
      expect(subscription.cancelReason).toBeNull()
      expect(subscription.autoRenew).toBe(true)

      // Verifica evento de reactivación
      expect(eventRepo.create).toHaveBeenCalledWith(expect.objectContaining({
        subscriptionId: 'sub-1',
        eventType: SubscriptionEventType.REACTIVATED,
        fromStatus: SubscriptionStatus.CANCELLED,
        toStatus: SubscriptionStatus.ACTIVE,
        triggeredBy: 'user-1',
      }))
      expect(result.data).toBeDefined()
    })

    it('lanza error si la suscripción no está cancelada', async () => {
      const subscription = {
        id: 'sub-1',
        brandId: 'brand-1',
        provider: SubscriptionProvider.WALLET,
        status: SubscriptionStatus.ACTIVE,
      }
      subscriptionRepo.findOne.mockResolvedValue(subscription)

      await expect(service.reactivate('brand-1', 'user-1')).rejects.toThrow(RequestException)
    })

    /**
     * Con la cancelación REAL, revivir una fila `confio` sería pro gratis: este
     * endpoint sólo recibe `{brandId, triggeredBy}` y no hay pago detrás, y del
     * lado de ConfioPagos la suscripción ya está `CANCELED` y no vuelve a cobrar.
     */
    it('una fila de ConfioPagos cancelada NO se reactiva: 422 y cero escrituras', async () => {
      const subscription = {
        id: 'sub-1',
        brandId: 'brand-1',
        provider: SubscriptionProvider.CONFIO,
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: 'motivo',
        autoRenew: false,
      }
      subscriptionRepo.findOne.mockResolvedValue(subscription)

      const error = await service.reactivate('brand-1', 'user-1').catch((e) => e)

      expect(error).toBeInstanceOf(RequestException)
      expect(error.code).toBe('CONFIO_REACTIVATE_NOT_SUPPORTED')
      expect(error.getStatus()).toBe(422)
      expect(subscription.status).toBe(SubscriptionStatus.CANCELLED)
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
      expect(eventRepo.save).not.toHaveBeenCalled()
    })
  })

  describe('getHistory', () => {
    it('retorna el historial de eventos de suscripción', async () => {
      const subscription = { id: 'sub-1', brandId: 'brand-1' }
      const events = [
        { id: 'ev-1', subscriptionId: 'sub-1', eventType: SubscriptionEventType.CREATED },
        { id: 'ev-2', subscriptionId: 'sub-1', eventType: SubscriptionEventType.CANCELLED },
      ]
      subscriptionReadRepo.findOne.mockResolvedValue(subscription)
      eventReadRepo.find.mockResolvedValue(events)

      const result = await service.getHistory('brand-1')

      expect(result.data).toEqual(events)
      expect(subscriptionReadRepo.findOne).toHaveBeenCalledWith({
        where: { brandId: 'brand-1' },
      })
      expect(eventReadRepo.find).toHaveBeenCalledWith({
        where: { subscriptionId: 'sub-1' },
        order: { createdAt: 'DESC' },
      })
    })

    it('lanza error si no existe suscripción', async () => {
      subscriptionReadRepo.findOne.mockResolvedValue(null)

      await expect(service.getHistory('brand-1')).rejects.toThrow(RequestException)
    })
  })
})
