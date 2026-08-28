import { TasksService } from './tasks.service'
import { SubscriptionStatus } from '../subscription/entities/subscription.entity'
import { SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'

const mockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  save: jest.fn((d) => Promise.resolve(d)),
  create: jest.fn((d) => d),
  update: jest.fn().mockResolvedValue({ affected: 0 }),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
})

describe('TasksService — processTrialConversions', () => {
  let service: TasksService
  let subscriptionRepo: ReturnType<typeof mockRepo>
  let subscriptionEventRepo: ReturnType<typeof mockRepo>
  let clientRoles: any
  let walletService: any
  let eventBus: any
  let checkoutService: any
  let paymentRepo: ReturnType<typeof mockRepo>
  let providerFactory: any

  beforeEach(() => {
    subscriptionRepo = mockRepo()
    // Los dos disparadores de cron vencen la fila con un compare-and-set
    // (`update` con el estado esperado en el criterio), no con `save`: `affected`
    // es lo que distingue «la vencí yo» de «me la ganó una pasada solapada».
    subscriptionRepo.update.mockResolvedValue({ affected: 1 })
    subscriptionEventRepo = mockRepo()
    paymentRepo = mockRepo()
    providerFactory = { getProvider: jest.fn() }
    clientRoles = {
      removePlanFromBrand: jest.fn().mockResolvedValue(true),
      assignPlanToBrand: jest.fn().mockResolvedValue(true),
      renewPlanForBrand: jest.fn().mockResolvedValue(true),
      getPlanPrice: jest.fn().mockResolvedValue(0),
    }
    walletService = { debit: jest.fn().mockResolvedValue(true), credit: jest.fn() }
    eventBus = {
      publishSubscriptionExpired: jest.fn(),
      notifySubscriptionExpired: jest.fn().mockResolvedValue(null),
      publishSubscriptionRenewed: jest.fn(),
      notifyPaymentFailed: jest.fn().mockResolvedValue(null),
      publishNotification: jest.fn().mockResolvedValue(null),
    }
    checkoutService = {
      processCheckout: jest.fn().mockResolvedValue({ paymentId: 'pay-1', status: 'pending', checkoutUrl: 'https://pay.confio/abc' }),
      completeExternalPayment: jest.fn().mockResolvedValue(undefined),
    }

    service = new TasksService(
      mockRepo() as any, // walletReadRepo
      mockRepo() as any, // snapshotRepo
      mockRepo() as any, // transactionReadRepo
      paymentRepo as any,
      subscriptionRepo as any,
      subscriptionEventRepo as any,
      mockRepo() as any, // webhookEventRepo
      {} as any, // dataSource
      walletService as any,
      {} as any, // auditService
      providerFactory as any,
      eventBus as any,
      clientRoles as any,
      checkoutService as any,
    )
  })

  it('degrada a free un trial vencido sin método de pago', async () => {
    subscriptionRepo.find.mockResolvedValue([
      { id: 's1', brandId: 'b1', planSlug: 'pro', provider: 'wallet', walletId: null, status: SubscriptionStatus.TRIAL },
    ])

    await service.processTrialConversions()

    // El estado terminal se escribe con un compare-and-set contra `trial`.
    expect(subscriptionRepo.update).toHaveBeenCalledWith(
      { id: 's1', status: SubscriptionStatus.TRIAL },
      { status: SubscriptionStatus.EXPIRED, autoRenew: false },
    )
    expect(subscriptionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: SubscriptionEventType.TRIAL_ENDED }),
    )
    expect(clientRoles.removePlanFromBrand).toHaveBeenCalledWith('b1', 'pro')
    expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
    // `free` SIN `expiresAt`: un plan que no se cobra no vence. Con un tercer
    // argumento el cron de roles lo barrería y la marca quedaría sin plan.
    expect(clientRoles.assignPlanToBrand.mock.calls[0]).toHaveLength(2)
    expect(walletService.debit).not.toHaveBeenCalled()
  })

  // Aceptación 5: un canal caído no es un hecho sobre la suscripción. Si roles no
  // acepta el retiro, la fila NO se marca degradada y el cron horario la retoma.
  it('un trial sin método de pago que roles rechaza no queda marcado como degradado', async () => {
    clientRoles.removePlanFromBrand.mockResolvedValue(false)
    subscriptionRepo.find.mockResolvedValue([
      {
        id: 's1',
        brandId: 'b1',
        planSlug: 'pro',
        provider: 'wallet',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
      },
    ])

    await service.processTrialConversions()

    expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
    expect(subscriptionRepo.save).not.toHaveBeenCalled()
    expect(subscriptionRepo.update).not.toHaveBeenCalled()
    expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
    expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
  })

  // Una pasada solapada ya terminó el trial: el compare-and-set no afecta filas y
  // esta pasada no escribe una SEGUNDA fila de historial (aceptación 4).
  it('un trial que otra pasada ya terminó no escribe un segundo evento', async () => {
    subscriptionRepo.update.mockResolvedValue({ affected: 0 })
    subscriptionRepo.find.mockResolvedValue([
      {
        id: 's1',
        brandId: 'b1',
        planSlug: 'pro',
        provider: 'wallet',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
      },
    ])

    await service.processTrialConversions()

    expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
    expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
  })

  it('cobra de wallet y activa un trial vencido con método de pago', async () => {
    clientRoles.getPlanPrice.mockResolvedValue(50000)
    subscriptionRepo.find.mockResolvedValue([
      { id: 's1', brandId: 'b1', planSlug: 'pro', provider: 'wallet', walletId: 'w1', status: SubscriptionStatus.TRIAL, retryCount: 0 },
    ])

    await service.processTrialConversions()

    // 3 argumentos exactos: el cron NO pasa `expectedCurrency`. La aserción se rompe el
    // día que alguien cablee la guarda de moneda dentro de `renewFromWallet`.
    expect(walletService.debit).toHaveBeenCalledWith('w1', 50000, expect.any(Object))
    expect(subscriptionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: SubscriptionStatus.ACTIVE }),
    )
    expect(clientRoles.renewPlanForBrand).toHaveBeenCalled()
    expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalledWith('b1', 'free')
  })

  it('marca past_due si el cobro de wallet falla por saldo insuficiente', async () => {
    clientRoles.getPlanPrice.mockResolvedValue(50000)
    walletService.debit.mockRejectedValue(new Error('saldo insuficiente'))
    subscriptionRepo.find.mockResolvedValue([
      { id: 's1', brandId: 'b1', planSlug: 'pro', provider: 'wallet', walletId: 'w1', status: SubscriptionStatus.TRIAL, retryCount: 0 },
    ])

    await service.processTrialConversions()

    expect(subscriptionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: SubscriptionStatus.PAST_DUE }),
    )
    expect(eventBus.notifyPaymentFailed).toHaveBeenCalled()
  })

  it('emite link de cobro Confío para un trial externo vencido (no degrada)', async () => {
    subscriptionRepo.find.mockResolvedValue([
      // `initialPaymentLinkIssuedAt: null` explícito: es el discriminante del caso de al lado.
      {
        id: 's1',
        brandId: 'b1',
        userId: 'u1',
        planSlug: 'pro',
        provider: 'confio',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
        retryCount: 0,
        initialPaymentLinkIssuedAt: null,
      },
    ])

    await service.processTrialConversions()

    expect(checkoutService.processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'confio',
        purpose: 'plan_purchase',
        planSlug: 'pro',
        brandId: 'b1',
        renewal: true,
      }),
    )
    expect(subscriptionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: SubscriptionStatus.PAST_DUE }),
    )
    // Notifica el link de pago, NO degrada a free.
    expect(eventBus.publishNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment_link' }),
    )
    expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalledWith('b1', 'free')
  })

  it('NO emite un segundo link si el alta ya emitió el link inicial', async () => {
    subscriptionRepo.find.mockResolvedValue([
      {
        id: 's1',
        brandId: 'b1',
        userId: 'u1',
        planSlug: 'dropi-roax',
        provider: 'confio',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
        retryCount: 0,
        initialPaymentLinkIssuedAt: new Date('2026-08-10T00:00:00Z'),
      },
    ])

    await service.processTrialConversions()

    // Ni segundo link ni notificación ni cambio de estado: la fila queda intacta.
    expect(checkoutService.processCheckout).not.toHaveBeenCalled()
    expect(subscriptionRepo.save).not.toHaveBeenCalled()
    expect(eventBus.publishNotification).not.toHaveBeenCalled()
    // Tampoco degrada: la degradación por `trialEnd` es de otra tarea.
    expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalledWith('b1', 'free')
  })

  it('lote mixto: sólo la fila sin marcar recibe link', async () => {
    subscriptionRepo.find.mockResolvedValue([
      {
        id: 's1',
        brandId: 'b-marcada',
        userId: 'u1',
        planSlug: 'dropi-roax',
        provider: 'confio',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
        retryCount: 0,
        initialPaymentLinkIssuedAt: new Date('2026-08-10T00:00:00Z'),
      },
      {
        id: 's2',
        brandId: 'b-sin-marcar',
        userId: 'u2',
        planSlug: 'dropi-roax',
        provider: 'confio',
        walletId: null,
        status: SubscriptionStatus.TRIAL,
        retryCount: 0,
        initialPaymentLinkIssuedAt: null,
      },
    ])

    await service.processTrialConversions()

    expect(checkoutService.processCheckout).toHaveBeenCalledTimes(1)
    expect(checkoutService.processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ brandId: 'b-sin-marcar' }),
    )
  })

  /**
   * `degradacion-a-free-y-baja-en-roles` (épica 002, criterio 3), tercer
   * disparador: la suscripción vence con los reintentos agotados.
   *
   * Rojo si: se quita `assignPlanToBrand(brandId, FREE_PLAN_SLUG)` de
   * `downgradeBrandToFree` (la mutación de control declarada por la tarea).
   */
  describe('expireSubscriptions', () => {
    const enMora = (over: Record<string, any> = {}) => ({
      id: 's1',
      brandId: 'b1',
      planSlug: 'pro',
      status: SubscriptionStatus.PAST_DUE,
      retryCount: 3,
      autoRenew: true,
      ...over,
    })

    it('con los reintentos agotados saca el plan pago y deja free', async () => {
      subscriptionRepo.find.mockResolvedValue([enMora()])

      await service.expireSubscriptions()

      expect(clientRoles.removePlanFromBrand).toHaveBeenCalledWith('b1', 'pro')
      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
      expect(clientRoles.assignPlanToBrand.mock.calls[0]).toHaveLength(2)
      expect(clientRoles.removePlanFromBrand.mock.invocationCallOrder[0]).toBeLessThan(
        clientRoles.assignPlanToBrand.mock.invocationCallOrder[0],
      )
      // ⚠️ DINERO: `autoRenew` encendido deja la fila elegible para los crons de
      // renovación, que emitirían un cobro sobre una suscripción ya vencida.
      // Compare-and-set contra `past_due`: dos pasadas solapadas no la vencen dos
      // veces (los `@Cron` de Nest no se excluyen entre sí).
      expect(subscriptionRepo.update).toHaveBeenCalledWith(
        { id: 's1', status: SubscriptionStatus.PAST_DUE },
        { status: SubscriptionStatus.EXPIRED, autoRenew: false },
      )
      expect(subscriptionEventRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: SubscriptionEventType.EXPIRED,
          fromStatus: SubscriptionStatus.PAST_DUE,
          toStatus: SubscriptionStatus.EXPIRED,
          triggeredBy: 'system',
          reason: expect.stringMatching(/reintentos/i),
        }),
      )
      expect(eventBus.publishSubscriptionExpired).toHaveBeenCalled()
    })

    it('la mora con reintentos disponibles no degrada ni escribe', async () => {
      subscriptionRepo.find.mockResolvedValue([enMora({ retryCount: 1 })])

      await service.expireSubscriptions()

      expect(clientRoles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.save).not.toHaveBeenCalled()
      expect(subscriptionRepo.update).not.toHaveBeenCalled()
    })

    it('si roles rechaza el retiro no vence la fila y la pasada siguiente reintenta', async () => {
      clientRoles.removePlanFromBrand.mockResolvedValue(false)
      const fila = enMora()
      subscriptionRepo.find.mockResolvedValue([fila])

      await service.expireSubscriptions()

      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
      expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
      // La fila NO se vence…
      expect(subscriptionRepo.update).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ status: SubscriptionStatus.EXPIRED }),
      )
      // …pero ⚠️ DINERO: en `past_due`, con `autoRenew` encendido y
      // `nextBillingDate` vencido, seguiría siendo elegible para
      // `processSubscriptionRenewals` y `retryFailedPayments`, que DEBITAN la
      // wallet. Mientras dure la caída de roles se apaga el riel de cobro, que no
      // toca el acceso, y la degradación se reintenta igual.
      expect(subscriptionRepo.update).toHaveBeenCalledWith({ id: 's1' }, { autoRenew: false })

      // La fila sigue en `past_due` con los reintentos agotados: el cron la vuelve
      // a tomar y, con roles de pie, la degrada. Idempotencia por reintento.
      clientRoles.removePlanFromBrand.mockResolvedValue(true)
      await service.expireSubscriptions()

      expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
      expect(subscriptionRepo.update).toHaveBeenCalledWith(
        { id: 's1', status: SubscriptionStatus.PAST_DUE },
        { status: SubscriptionStatus.EXPIRED, autoRenew: false },
      )
    })

    // Aceptación 4, «segunda pasada del cron»: la ventana entre el `find` y la
    // escritura es ancha (la degradación es HTTP con 10 s de timeout) y los
    // `@Cron` de Nest no se excluyen. El compare-and-set no afecta filas y esta
    // pasada no escribe una segunda fila de historial.
    it('una pasada solapada que ya venció la fila no escribe un segundo evento', async () => {
      subscriptionRepo.update.mockResolvedValue({ affected: 0 })
      subscriptionRepo.find.mockResolvedValue([enMora()])

      await service.expireSubscriptions()

      expect(subscriptionEventRepo.create).not.toHaveBeenCalled()
      expect(eventBus.publishSubscriptionExpired).not.toHaveBeenCalled()
    })

    // Un segmento vacío en el path de roles (`/v1/brand//plan/slug/`) da 404 →
    // `false`, indistinguible de un canal caído: sin esta guarda la fila no
    // vencería NUNCA. Misma decisión que `efectoRoles` en el webhook.
    it('una fila sin brandId/planSlug no llama a roles pero igual vence', async () => {
      subscriptionRepo.find.mockResolvedValue([enMora({ brandId: '', planSlug: '' })])

      await service.expireSubscriptions()

      expect(clientRoles.removePlanFromBrand).not.toHaveBeenCalled()
      expect(clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
      expect(subscriptionRepo.update).toHaveBeenCalledWith(
        { id: 's1', status: SubscriptionStatus.PAST_DUE },
        { status: SubscriptionStatus.EXPIRED, autoRenew: false },
      )
    })
  })

  describe('reconcileExternalPayments', () => {
    it('completa un pago confio pendiente cuyo estado real es completed', async () => {
      paymentRepo.find.mockResolvedValue([
        { id: 'pay-9', provider: 'confio', status: 'pending', providerPaymentId: 'stores/x/payments/y' },
      ])
      providerFactory.getProvider.mockReturnValue({
        getPaymentStatus: jest.fn().mockResolvedValue({ status: 'completed' }),
      })

      await service.reconcileExternalPayments()

      expect(checkoutService.completeExternalPayment).toHaveBeenCalledWith('pay-9', { source: 'cron-reconcile' })
    })

    it('NO completa si el estado real sigue pending', async () => {
      paymentRepo.find.mockResolvedValue([
        { id: 'pay-9', provider: 'confio', status: 'pending', providerPaymentId: 'stores/x/payments/y' },
      ])
      providerFactory.getProvider.mockReturnValue({
        getPaymentStatus: jest.fn().mockResolvedValue({ status: 'pending' }),
      })

      await service.reconcileExternalPayments()

      expect(checkoutService.completeExternalPayment).not.toHaveBeenCalled()
    })
  })
})
