import { randomUUID } from 'crypto'
import { config as dotenvConfig } from 'dotenv'
import { DataSource, FindManyOptions, In, Repository } from 'typeorm'

import { TasksService } from '../src/tasks/tasks.service'
import { Payment } from '../src/payment/entities/payment.entity'
import { logger } from '../src/shared/logger/logger'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../src/transaction/entities/transaction.entity'
import { WalletService } from '../src/wallet/wallet.service'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { WebhookEvent } from '../src/webhook/entities/webhookEvent.entity'

dotenvConfig({ path: '.env' })

const BALANCE = 200000
const PRICE = 50000

describe('Wallet renewal without nextBillingDate against a real database (e2e)', () => {
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
      getPlanPrice: jest.fn().mockResolvedValue(PRICE),
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

  /** A row as `POST /subscription` leaves it when the optional date is omitted. */
  const createFundedRow = async (overrides: Partial<Subscription> = {}) => {
    const brandId = `brand-undated-${randomUUID()}`
    const userId = randomUUID()
    const wallet = await walletRepo.save(
      walletRepo.create({
        userId,
        brandId,
        provider: 'internal',
        currency: 'COP',
        balance: BALANCE,
        status: WalletStatus.ACTIVE,
      }),
    )
    walletIds.push(wallet.id)
    const sub = await subscriptionRepo.save(
      subscriptionRepo.create({
        userId,
        brandId,
        planSlug: 'pro',
        status: SubscriptionStatus.PAST_DUE,
        provider: SubscriptionProvider.WALLET,
        walletId: wallet.id,
        autoRenew: true,
        retryCount: 1,
        currentPeriodStart: new Date(Date.now() - 32 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() - 2 * 60 * 60 * 1000),
        ...overrides,
      }),
    )
    subscriptionIds.push(sub.id)
    // Past the retry backoff, so the retry pass picks the row.
    await subscriptionRepo.query(
      `UPDATE subscriptions SET "updatedAt" = now() - interval '4 days' WHERE id = $1`,
      [sub.id],
    )
    return { sub, wallet }
  }

  const balanceOf = async (wallet: Wallet) =>
    Number((await walletRepo.findOneByOrFail({ id: wallet.id })).balance)

  const movementsOf = (wallet: Wallet) => transactionRepo.find({ where: { walletId: wallet.id } })

  it('leaves money and row untouched over repeated retry passes, and logs an error', async () => {
    // Red if the guard in renewFromWallet goes: the first pass charges the wallet.
    const { service, roles, eventBus } = createService()
    const { sub, wallet } = await createFundedRow()
    const logSpy = jest.spyOn(logger, 'log')

    await service.retryFailedPayments()
    await service.retryFailedPayments()

    expect(await balanceOf(wallet)).toBe(BALANCE)
    expect(await movementsOf(wallet)).toHaveLength(0)
    const stored = await subscriptionRepo.findOneByOrFail({ id: sub.id })
    expect(stored.status).toBe(SubscriptionStatus.PAST_DUE)
    expect(stored.retryCount).toBe(1)
    expect(stored.nextBillingDate).toBeNull()
    expect(await subscriptionEventRepo.find({ where: { subscriptionId: sub.id } })).toHaveLength(0)
    expect(eventBus.notifyPaymentFailed).not.toHaveBeenCalled()
    expect(roles.renewPlanForBrand).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith('error', expect.stringContaining(sub.id))
  })

  it('does not hand a later cycle free when a debit with the old literal key exists', async () => {
    // Red if the key falls back to the literal: the old debit counts and the period is extended.
    const { service, roles } = createService()
    const { sub, wallet } = await createFundedRow()
    await transactionRepo.save(
      transactionRepo.create({
        walletId: wallet.id,
        brandId: wallet.brandId,
        type: TransactionType.DEBIT,
        amount: PRICE,
        balanceBefore: BALANCE + PRICE,
        balanceAfter: BALANCE,
        status: TransactionStatus.COMPLETED,
        idempotencyKey: `subscription:${sub.id}:current`,
      }),
    )

    await service.retryFailedPayments()

    expect(roles.renewPlanForBrand).not.toHaveBeenCalled()
    expect(await balanceOf(wallet)).toBe(BALANCE)
    expect(await movementsOf(wallet)).toHaveLength(1)
    expect((await subscriptionRepo.findOneByOrFail({ id: sub.id })).nextBillingDate).toBeNull()
  })

  it('does not charge when a manual data fix clears the date after the pass read the row', async () => {
    // Red if the guard reads before lockAndReread: the stale date passes and the wallet is charged.
    const { service } = createService()
    const due = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const { sub, wallet } = await createFundedRow({
      status: SubscriptionStatus.ACTIVE,
      retryCount: 0,
      nextBillingDate: due,
    })
    const stale = await originalFind({ where: { id: sub.id } })
    await subscriptionRepo.query(
      `UPDATE subscriptions SET "nextBillingDate" = NULL WHERE id = $1`,
      [sub.id],
    )
    // R17: fixes what the pass read, so the cleared date only appears on the reread under the lock.
    jest.spyOn(subscriptionRepo, 'find').mockResolvedValue(stale)

    await service.processSubscriptionRenewals()

    expect(await balanceOf(wallet)).toBe(BALANCE)
    expect(await movementsOf(wallet)).toHaveLength(0)
  })

  it('still charges a dated row once when it shares the pass with an undated one', async () => {
    // Red if the guard also stops dated rows: the dated row is not charged.
    const { service } = createService()
    const undated = await createFundedRow()
    const due = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const dated = await createFundedRow({ nextBillingDate: due })

    await service.retryFailedPayments()

    expect(await balanceOf(dated.wallet)).toBe(BALANCE - PRICE)
    expect(await movementsOf(dated.wallet)).toEqual([
      expect.objectContaining({
        idempotencyKey: `subscription:${dated.sub.id}:${due.toISOString()}`,
      }),
    ])
    const renewed = await subscriptionRepo.findOneByOrFail({ id: dated.sub.id })
    expect(renewed.status).toBe(SubscriptionStatus.ACTIVE)
    expect(await balanceOf(undated.wallet)).toBe(BALANCE)
  })

  it('does not reach an active undated row at all: no charge, and no log for that row', async () => {
    // Red if the renewal query stops excluding a null date: the row reaches the guard and logs.
    const { service } = createService()
    const { sub, wallet } = await createFundedRow({
      status: SubscriptionStatus.ACTIVE,
      retryCount: 0,
    })
    const logSpy = jest.spyOn(logger, 'log')

    await service.processSubscriptionRenewals()
    await service.retryFailedPayments()

    expect(await balanceOf(wallet)).toBe(BALANCE)
    expect(logSpy).not.toHaveBeenCalledWith('error', expect.stringContaining(sub.id))
  })
})
