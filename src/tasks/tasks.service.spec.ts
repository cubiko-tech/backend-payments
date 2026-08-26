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

    expect(subscriptionRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: SubscriptionStatus.EXPIRED, autoRenew: false }),
    )
    expect(subscriptionEventRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: SubscriptionEventType.TRIAL_ENDED }),
    )
    expect(clientRoles.removePlanFromBrand).toHaveBeenCalledWith('b1', 'pro')
    expect(clientRoles.assignPlanToBrand).toHaveBeenCalledWith('b1', 'free')
    expect(walletService.debit).not.toHaveBeenCalled()
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
      { id: 's1', brandId: 'b1', userId: 'u1', planSlug: 'pro', provider: 'confio', walletId: null, status: SubscriptionStatus.TRIAL, retryCount: 0 },
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
