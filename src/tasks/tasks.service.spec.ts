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

  beforeEach(() => {
    subscriptionRepo = mockRepo()
    subscriptionEventRepo = mockRepo()
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
    }

    service = new TasksService(
      mockRepo() as any, // walletReadRepo
      mockRepo() as any, // snapshotRepo
      mockRepo() as any, // transactionReadRepo
      mockRepo() as any, // paymentRepo
      subscriptionRepo as any,
      subscriptionEventRepo as any,
      mockRepo() as any, // webhookEventRepo
      {} as any, // dataSource
      walletService as any,
      {} as any, // auditService
      {} as any, // providerFactory
      eventBus as any,
      clientRoles as any,
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

    expect(walletService.debit).toHaveBeenCalled()
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
})
