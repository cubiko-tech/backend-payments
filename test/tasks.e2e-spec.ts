import { randomUUID } from 'crypto'
import { config as dotenvConfig } from 'dotenv'
import { DataSource, FindManyOptions, In, Repository } from 'typeorm'

import { TasksService } from '../src/tasks/tasks.service'
import { Payment } from '../src/payment/entities/payment.entity'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../src/subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../src/subscription/entities/subscriptionEvent.entity'
import { WalletService } from '../src/wallet/wallet.service'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { WebhookEvent } from '../src/webhook/entities/webhookEvent.entity'

dotenvConfig({ path: '.env' })

describe('TasksService renewal and expiration concurrency (e2e)', () => {
  let dataSource: DataSource
  let walletRepo: Repository<Wallet>
  let snapshotRepo: Repository<WalletBalanceSnapshot>
  let transactionRepo: Repository<Transaction>
  let paymentRepo: Repository<Payment>
  let subscriptionRepo: Repository<Subscription>
  let subscriptionEventRepo: Repository<SubscriptionEvent>
  let webhookEventRepo: Repository<WebhookEvent>
  let originalSubscriptionFind: Repository<Subscription>['find']
  const createdWalletIds: string[] = []
  const createdSubscriptionIds: string[] = []

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [
        Wallet,
        WalletBalanceSnapshot,
        Transaction,
        Payment,
        Subscription,
        SubscriptionEvent,
        WebhookEvent,
      ],
      synchronize: false,
      ...(process.env.SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    })
    await dataSource.initialize()

    walletRepo = dataSource.getRepository(Wallet)
    snapshotRepo = dataSource.getRepository(WalletBalanceSnapshot)
    transactionRepo = dataSource.getRepository(Transaction)
    paymentRepo = dataSource.getRepository(Payment)
    subscriptionRepo = dataSource.getRepository(Subscription)
    subscriptionEventRepo = dataSource.getRepository(SubscriptionEvent)
    webhookEventRepo = dataSource.getRepository(WebhookEvent)
    originalSubscriptionFind = subscriptionRepo.find.bind(subscriptionRepo)
  })

  beforeEach(() => {
    jest
      .spyOn(subscriptionRepo, 'find')
      .mockImplementation(async (options?: FindManyOptions<Subscription>) => {
        if (createdSubscriptionIds.length === 0) {
          return []
        }
        const baseWhere = (options?.where ?? {}) as Record<string, unknown>
        return originalSubscriptionFind({
          ...options,
          where: {
            ...baseWhere,
            id: In(createdSubscriptionIds),
          },
        })
      })
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    if (createdSubscriptionIds.length > 0) {
      await subscriptionEventRepo.delete({ subscriptionId: In(createdSubscriptionIds) })
      await subscriptionRepo.delete({ id: In(createdSubscriptionIds) })
      createdSubscriptionIds.length = 0
    }
    if (createdWalletIds.length > 0) {
      await transactionRepo.delete({ walletId: In(createdWalletIds) })
      await walletRepo.delete({ id: In(createdWalletIds) })
      createdWalletIds.length = 0
    }
  })

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy()
    }
  })

  const createRealTasksService = (rolesOverrides: Partial<Record<string, any>> = {}) => {
    const walletService = new WalletService(
      walletRepo,
      walletRepo,
      transactionRepo,
      transactionRepo,
      dataSource,
    )

    const rolesMock = {
      removePlanFromBrand: jest.fn().mockResolvedValue(true),
      assignPlanToBrand: jest.fn().mockResolvedValue(true),
      renewPlanForBrand: jest.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
        return true
      }),
      getPlanPrice: jest.fn().mockResolvedValue(50000),
      hasCachedPrices: jest.fn().mockReturnValue(true),
      ...rolesOverrides,
    }

    const eventBusMock = {
      publishSubscriptionExpired: jest.fn(),
      notifySubscriptionExpired: jest.fn().mockResolvedValue(null),
      publishSubscriptionRenewed: jest.fn(),
      notifyPaymentFailed: jest.fn().mockResolvedValue(null),
      publishNotification: jest.fn().mockResolvedValue(null),
    }

    const tasksService = new TasksService(
      walletRepo,
      snapshotRepo,
      transactionRepo,
      paymentRepo,
      subscriptionRepo,
      subscriptionEventRepo,
      webhookEventRepo,
      dataSource,
      walletService,
      { log: jest.fn(), logTransactionCreated: jest.fn() } as any,
      { getProvider: jest.fn() } as any,
      eventBusMock as any,
      rolesMock as any,
      { processCheckout: jest.fn(), completeExternalPayment: jest.fn() } as any,
      { confirmarContraElProveedor: jest.fn() } as any,
    )

    return { tasksService, rolesMock, eventBusMock }
  }

  it('lets only expireSubscriptions expire a PAST_DUE subscription with exhausted retries without debiting the wallet', async () => {
    const { tasksService, rolesMock } = createRealTasksService()

    const brandId = `brand-exhausted-${randomUUID()}`
    const userId = randomUUID()
    const wallet = await walletRepo.save(
      walletRepo.create({
        userId,
        brandId,
        provider: 'internal',
        currency: 'COP',
        balance: 200000,
        status: WalletStatus.ACTIVE,
      }),
    )
    createdWalletIds.push(wallet.id)

    const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const sub = await subscriptionRepo.save(
      subscriptionRepo.create({
        userId,
        brandId,
        planSlug: 'pro',
        status: SubscriptionStatus.PAST_DUE,
        provider: SubscriptionProvider.WALLET,
        walletId: wallet.id,
        autoRenew: true,
        retryCount: 3,
        currentPeriodStart: new Date(pastDate.getTime() - 30 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: pastDate,
        nextBillingDate: pastDate,
      }),
    )
    createdSubscriptionIds.push(sub.id)

    await Promise.all([
      tasksService.processSubscriptionRenewals(),
      tasksService.expireSubscriptions(),
    ])

    const updatedSub = await subscriptionRepo.findOneByOrFail({ id: sub.id })
    const updatedWallet = await walletRepo.findOneByOrFail({ id: wallet.id })
    const transactions = await transactionRepo.find({ where: { walletId: wallet.id } })
    const events = await subscriptionEventRepo.find({ where: { subscriptionId: sub.id } })

    expect(updatedSub.status).toBe(SubscriptionStatus.EXPIRED)
    expect(updatedSub.autoRenew).toBe(false)
    expect(Number(updatedWallet.balance)).toBe(200000)
    expect(transactions).toHaveLength(0)
    expect(rolesMock.renewPlanForBrand).not.toHaveBeenCalled()
    expect(rolesMock.removePlanFromBrand).toHaveBeenCalledWith(brandId, 'pro')
    expect(rolesMock.assignPlanToBrand).toHaveBeenCalledWith(brandId, 'free')
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe(SubscriptionEventType.EXPIRED)
  })

  it('produces a coherent final state and a single wallet debit when renewal and expiration passes run concurrently on a due subscription', async () => {
    const { tasksService, rolesMock } = createRealTasksService()

    const brandId = `brand-concurrent-${randomUUID()}`
    const userId = randomUUID()
    const wallet = await walletRepo.save(
      walletRepo.create({
        userId,
        brandId,
        provider: 'internal',
        currency: 'COP',
        balance: 200000,
        status: WalletStatus.ACTIVE,
      }),
    )
    createdWalletIds.push(wallet.id)

    const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const sub = await subscriptionRepo.save(
      subscriptionRepo.create({
        userId,
        brandId,
        planSlug: 'pro',
        status: SubscriptionStatus.PAST_DUE,
        provider: SubscriptionProvider.WALLET,
        walletId: wallet.id,
        autoRenew: true,
        retryCount: 2,
        currentPeriodStart: new Date(pastDate.getTime() - 30 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: pastDate,
        nextBillingDate: pastDate,
      }),
    )
    createdSubscriptionIds.push(sub.id)

    await Promise.all([
      tasksService.processSubscriptionRenewals(),
      tasksService.processSubscriptionRenewals(),
      tasksService.expireSubscriptions(),
    ])

    const updatedSub = await subscriptionRepo.findOneByOrFail({ id: sub.id })
    const updatedWallet = await walletRepo.findOneByOrFail({ id: wallet.id })
    const transactions = await transactionRepo.find({ where: { walletId: wallet.id } })
    const events = await subscriptionEventRepo.find({ where: { subscriptionId: sub.id } })

    expect(updatedSub.status).toBe(SubscriptionStatus.ACTIVE)
    expect(updatedSub.retryCount).toBe(0)
    expect(updatedSub.autoRenew).toBe(true)
    expect(updatedSub.nextBillingDate!.getTime()).toBeGreaterThan(Date.now())
    expect(Number(updatedWallet.balance)).toBe(150000)
    expect(transactions).toHaveLength(1)
    expect(rolesMock.renewPlanForBrand).toHaveBeenCalledTimes(1)
    expect(rolesMock.removePlanFromBrand).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe(SubscriptionEventType.RENEWED)
  })

  it('releases the Postgres advisory lock and connection in finally when update throws during expireSubscriptions so the next pass expires the subscription', async () => {
    const { tasksService } = createRealTasksService()

    const brandId = `brand-lock-recovery-${randomUUID()}`
    const userId = randomUUID()
    const wallet = await walletRepo.save(
      walletRepo.create({
        userId,
        brandId,
        provider: 'internal',
        currency: 'COP',
        balance: 200000,
        status: WalletStatus.ACTIVE,
      }),
    )
    createdWalletIds.push(wallet.id)

    const pastDate = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const sub = await subscriptionRepo.save(
      subscriptionRepo.create({
        userId,
        brandId,
        planSlug: 'pro',
        status: SubscriptionStatus.PAST_DUE,
        provider: SubscriptionProvider.WALLET,
        walletId: wallet.id,
        autoRenew: true,
        retryCount: 3,
        currentPeriodStart: new Date(pastDate.getTime() - 30 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: pastDate,
        nextBillingDate: pastDate,
      }),
    )
    createdSubscriptionIds.push(sub.id)

    const originalUpdate = subscriptionRepo.update.bind(subscriptionRepo)
    const updateSpy = jest
      .spyOn(subscriptionRepo, 'update')
      .mockRejectedValueOnce(new Error('transient postgres update failure'))
      .mockImplementation((...args: Parameters<typeof originalUpdate>) => originalUpdate(...args))

    await expect(tasksService.expireSubscriptions()).rejects.toThrow(
      'transient postgres update failure',
    )

    const afterFailedPass = await subscriptionRepo.findOneByOrFail({ id: sub.id })
    expect(afterFailedPass.status).toBe(SubscriptionStatus.PAST_DUE)

    await Promise.race([
      tasksService.expireSubscriptions(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Second expireSubscriptions pass hung on unreleased lock')),
          1000,
        ),
      ),
    ])

    const afterRetryPass = await subscriptionRepo.findOneByOrFail({ id: sub.id })
    expect(afterRetryPass.status).toBe(SubscriptionStatus.EXPIRED)
    expect(afterRetryPass.autoRenew).toBe(false)
    expect(updateSpy).toHaveBeenCalledTimes(2)
  })
})
