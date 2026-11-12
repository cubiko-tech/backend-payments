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

describe('Wallet subscription without walletId against a real database (e2e)', () => {
  let dataSource: DataSource
  let walletRepo: Repository<Wallet>
  let transactionRepo: Repository<Transaction>
  let subscriptionRepo: Repository<Subscription>
  let subscriptionEventRepo: Repository<SubscriptionEvent>
  let originalFind: Repository<Subscription>['find']
  const walletIds: string[] = []
  const subscriptionIds: string[] = []

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
    transactionRepo = dataSource.getRepository(Transaction)
    subscriptionRepo = dataSource.getRepository(Subscription)
    subscriptionEventRepo = dataSource.getRepository(SubscriptionEvent)
    originalFind = subscriptionRepo.find.bind(subscriptionRepo)
  })

  beforeEach(() => {
    // R17: the crons read every row of the table; this scopes a pass to the rows of the case.
    jest
      .spyOn(subscriptionRepo, 'find')
      .mockImplementation(async (options?: FindManyOptions<Subscription>) =>
        originalFind({
          ...options,
          where: { ...((options?.where ?? {}) as object), id: In(subscriptionIds) },
        }),
      )
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await subscriptionEventRepo.delete({ subscriptionId: In(subscriptionIds) })
    await subscriptionRepo.delete({ id: In(subscriptionIds) })
    await transactionRepo.delete({ walletId: In(walletIds) })
    await walletRepo.delete({ id: In(walletIds) })
    subscriptionIds.length = 0
    walletIds.length = 0
  })

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy()
  })

  const createService = () => {
    // R17: roles and the event bus are other services; the case asserts what reaches them.
    const roles = {
      removePlanFromBrand: jest.fn().mockResolvedValue(true),
      assignPlanToBrand: jest.fn().mockResolvedValue(true),
      renewPlanForBrand: jest.fn().mockResolvedValue(true),
      getPlanPrice: jest.fn().mockResolvedValue(50000),
      hasCachedPrices: jest.fn().mockReturnValue(true),
    }
    const eventBus = {
      publishSubscriptionExpired: jest.fn(),
      notifySubscriptionExpired: jest.fn().mockResolvedValue(null),
      publishSubscriptionRenewed: jest.fn(),
      notifyPaymentFailed: jest.fn().mockResolvedValue(null),
      publishNotification: jest.fn().mockResolvedValue(null),
    }
    const service = new TasksService(
      walletRepo,
      dataSource.getRepository(WalletBalanceSnapshot),
      transactionRepo,
      dataSource.getRepository(Payment),
      subscriptionRepo,
      subscriptionEventRepo,
      dataSource.getRepository(WebhookEvent),
      dataSource,
      new WalletService(walletRepo, walletRepo, transactionRepo, transactionRepo, dataSource),
      { log: jest.fn(), logTransactionCreated: jest.fn() } as any,
      { getProvider: jest.fn() } as any,
      eventBus as any,
      roles as any,
      { processCheckout: jest.fn(), completeExternalPayment: jest.fn() } as any,
      { confirmarContraElProveedor: jest.fn() } as any,
    )
    return { service, roles, eventBus }
  }

  const createWallet = async (brandId: string, userId: string) => {
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
    walletIds.push(wallet.id)
    return wallet
  }

  const createSubscription = async (overrides: Partial<Subscription> = {}) => {
    const due = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const sub = await subscriptionRepo.save(
      subscriptionRepo.create({
        userId: randomUUID(),
        brandId: `brand-no-wallet-${randomUUID()}`,
        planSlug: 'pro',
        status: SubscriptionStatus.ACTIVE,
        provider: SubscriptionProvider.WALLET,
        autoRenew: true,
        retryCount: 0,
        currentPeriodStart: new Date(due.getTime() - 30 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: due,
        nextBillingDate: due,
        ...overrides,
      }),
    )
    subscriptionIds.push(sub.id)
    return sub
  }

  const backdateUpdate = (id: string) =>
    subscriptionRepo.query(
      `UPDATE subscriptions SET "updatedAt" = now() - interval '4 days' WHERE id = $1`,
      [id],
    )

  it('keeps an active row unchanged over repeated renewal passes and an expiration pass', async () => {
    // Red if the walletId check in processSubscriptionRenewals goes: the row ends past_due.
    const { service, roles, eventBus } = createService()
    const sub = await createSubscription()

    await service.processSubscriptionRenewals()
    await service.processSubscriptionRenewals()
    await service.expireSubscriptions()

    const stored = await subscriptionRepo.findOneByOrFail({ id: sub.id })
    expect(stored.status).toBe(SubscriptionStatus.ACTIVE)
    expect(stored.retryCount).toBe(0)
    expect(await subscriptionEventRepo.find({ where: { subscriptionId: sub.id } })).toHaveLength(0)
    expect(eventBus.notifyPaymentFailed).not.toHaveBeenCalled()
    expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
  })

  it('does not add a retry to a past-due row over repeated retry passes', async () => {
    // Red if the walletId check in retryFailedPayments goes: retryCount rises to 2.
    const { service, roles, eventBus } = createService()
    const sub = await createSubscription({ status: SubscriptionStatus.PAST_DUE, retryCount: 1 })
    await backdateUpdate(sub.id)

    await service.retryFailedPayments()
    await service.retryFailedPayments()
    await service.expireSubscriptions()

    const stored = await subscriptionRepo.findOneByOrFail({ id: sub.id })
    expect(stored.status).toBe(SubscriptionStatus.PAST_DUE)
    expect(stored.retryCount).toBe(1)
    expect(eventBus.notifyPaymentFailed).not.toHaveBeenCalled()
    expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
  })

  it('still renews a row with wallet that shares the pass with a row without one', async () => {
    // Red if the walletId check in processSubscriptionRenewals goes: the row without one fails.
    const { service, roles } = createService()
    const userId = randomUUID()
    const brandId = `brand-with-wallet-${randomUUID()}`
    const wallet = await createWallet(brandId, userId)
    const without = await createSubscription()
    const withWallet = await createSubscription({ userId, brandId, walletId: wallet.id })

    await service.processSubscriptionRenewals()

    const renewed = await subscriptionRepo.findOneByOrFail({ id: withWallet.id })
    expect(renewed.status).toBe(SubscriptionStatus.ACTIVE)
    expect(renewed.nextBillingDate!.getTime()).toBeGreaterThan(Date.now())
    expect(Number((await walletRepo.findOneByOrFail({ id: wallet.id })).balance)).toBe(150000)
    expect(await transactionRepo.find({ where: { walletId: wallet.id } })).toHaveLength(1)
    expect(roles.renewPlanForBrand).toHaveBeenCalledTimes(1)
    expect((await subscriptionRepo.findOneByOrFail({ id: without.id })).retryCount).toBe(0)
  })

  it('renews a row that got its walletId after the pass read it, because the lock rereads it', async () => {
    // Red if lockAndReread stops copying the fresh row: the stale null walletId skips the charge.
    const { service } = createService()
    const userId = randomUUID()
    const brandId = `brand-late-wallet-${randomUUID()}`
    const wallet = await createWallet(brandId, userId)
    const sub = await createSubscription({ userId, brandId })
    const stale = await originalFind({ where: { id: sub.id } })
    await subscriptionRepo.update({ id: sub.id }, { walletId: wallet.id })
    // R17: fixes what the pass read, so the walletId only appears on the reread under the lock.
    jest.spyOn(subscriptionRepo, 'find').mockResolvedValue(stale)

    await service.processSubscriptionRenewals()

    const stored = await subscriptionRepo.findOneByOrFail({ id: sub.id })
    expect(stored.nextBillingDate!.getTime()).toBeGreaterThan(Date.now())
    expect(await subscriptionEventRepo.find({ where: { subscriptionId: sub.id } })).toEqual([
      expect.objectContaining({ eventType: SubscriptionEventType.RENEWED }),
    ])
    expect(await transactionRepo.find({ where: { walletId: wallet.id } })).toHaveLength(1)
  })
})
