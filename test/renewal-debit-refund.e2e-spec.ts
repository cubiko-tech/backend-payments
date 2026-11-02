/**
 * R6: One responsibility, the refund of an orphan renewal debit, with one case per state a pass, a
 * sweep or a checkout can leave it in; splitting them would split one state machine.
 */
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { ClientRolesService } from '../src/client/client-roles.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { logger } from '../src/shared/logger/logger'
import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { CycleExtension, markCycleDebit } from '../src/tasks/renewal-debit-refund'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { DAY_MS, daysLeft, seedSubscription, sweepOnlyBrands } from './support/plan-lock.fixture'
import {
  balanceOf,
  cleanBrand,
  createGate,
  planCheckout,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  someoneWaitsOnAdvisoryLock,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7105001-2222-4333-8444-555555555555'
const BALANCE = 100000
const PLAN = 'dropi-roax'

/** What a renewal debit that lost its extension leaves behind, over real PostgreSQL. */
describe('An orphan renewal debit goes back to the wallet (PostgreSQL, LOC-105)', () => {
  let a: RaceInstance
  let b: RaceInstance
  let renewPlan: jest.SpyInstance

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
  })

  const cleanAll = async () => {
    await a.dataSource.query(
      `DELETE FROM audit_log WHERE "entityType" = 'subscription' AND "entityId" IN
       (SELECT id::text FROM subscriptions WHERE "brandId" = $1)`,
      [BRAND_ID],
    )
    await cleanBrand(a.dataSource, BRAND_ID)
  }

  beforeEach(async () => {
    await cleanAll()
    // R17: roles is another service, and its rejection is the cause every case starts from.
    renewPlan = jest
      .spyOn(a.moduleRef.get(ClientRolesService), 'renewPlanForBrand')
      .mockResolvedValue(false)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanAll()
    await stopInstance(a)
    await stopInstance(b)
  })

  const subscription = async () =>
    (await a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID }))!

  const renewalDebits = () =>
    a.dataSource.getRepository(Transaction).findBy({
      brandId: BRAND_ID,
      type: TransactionType.DEBIT,
      referenceType: 'subscription',
    })

  const marks = async () => (await renewalDebits()).map((debit) => debit.metadata?.cycleExtension)

  const refunds = () =>
    a.dataSource
      .getRepository(Transaction)
      .findBy({ brandId: BRAND_ID, type: TransactionType.CREDIT, category: 'refund' })

  const audits = async () =>
    a.dataSource.getRepository(AuditLog).countBy({
      action: 'renewal_debit_refunded',
      entityId: (await subscription()).id,
    })

  /** A due wallet row whose cron pass charged it while roles rejected the renewal. */
  const debitedAndRejected = async (overrides: Partial<Subscription> = {}) => {
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await seedSubscription(a.dataSource, BRAND_ID, { walletId: wallet.id, ...overrides })
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.processSubscriptionRenewals()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await marks()).toEqual([CycleExtension.PENDING])
    return wallet
  }

  const buy = (walletId: string, key: string) =>
    a.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, PLAN))

  /** The real service for cancel and reactivate; the Confio clients are other systems, unused here. */
  const subscriptions = () => {
    const repo = a.dataSource.getRepository(Subscription)
    const events = a.dataSource.getRepository(SubscriptionEvent)
    // R17: a wallet row reaches neither Confio nor the bus in a way these cases assert.
    return new SubscriptionService(
      repo,
      repo,
      events,
      events,
      a.dataSource,
      { publishNotification: jest.fn(), publishSubscriptionCancelled: jest.fn() } as any,
      {} as any,
      {} as any,
      {} as any,
    )
  }

  /** Cancels through the service, lets the paid access run out, and closes through the cron. */
  const cancelAndClose = async () => {
    await subscriptions().cancel(BRAND_ID, { reason: 'test', triggeredBy: 'user-loc105' })
    await a.dataSource
      .getRepository(Subscription)
      .update({ brandId: BRAND_ID }, { accessEndsAt: new Date(Date.now() - DAY_MS) })
    Object.assign(a.moduleRef.get(ClientRolesService), {
      removePlanFromBrand: jest.fn().mockResolvedValue(true),
    })
    Object.assign(a.moduleRef.get(EventBusService), {
      publishSubscriptionExpired: jest.fn(),
      notifySubscriptionExpired: jest.fn().mockResolvedValue(null),
    })
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.expireCancelledSubscriptions()
    expect((await subscription()).status).toBe(SubscriptionStatus.CANCELLED)
  }

  it('E1: a checkout that moves the date leaves one charge and one extension', async () => {
    // R15: red if refundRenewalDebit does not credit: two charges and 30 days remain.
    const wallet = await debitedAndRejected()
    await buy(wallet.id, 'loc105-e1')
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)

    await a.tasks.refundOrphanRenewalDebits()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await refunds()).toHaveLength(1)
    expect(await marks()).toEqual([CycleExtension.REFUNDED])
    expect(await audits()).toBe(1)
    expect(daysLeft(await subscription())).toBe(30)
  })

  it('E1: logs the refund with the subscription, the wallet and the amount', async () => {
    // R15: red if refundRenewalDebit stops logging: the money moves with no trace in the log.
    const wallet = await debitedAndRejected()
    await buy(wallet.id, 'loc105-e1-log')
    const logSpy = jest.spyOn(logger, 'log')

    await a.tasks.refundOrphanRenewalDebits()

    const { id } = await subscription()
    expect(logSpy).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining(`subscription=${id} wallet=${wallet.id} amount=${PLAN_PRICE}`),
    )
  })

  it('E2: a second sweep neither credits nor audits again', async () => {
    // R15: red if the debit is not marked refunded: the second sweep audits again.
    const wallet = await debitedAndRejected()
    await buy(wallet.id, 'loc105-e2')

    await a.tasks.refundOrphanRenewalDebits()
    await a.tasks.refundOrphanRenewalDebits()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await refunds()).toHaveLength(1)
    expect(await audits()).toBe(1)
  })

  it('E3: when the next pass can extend, it extends and nothing goes back', async () => {
    // R15: red if the extension does not mark the debit: the sweep refunds an extended cycle.
    const wallet = await debitedAndRejected()
    renewPlan.mockResolvedValue(true)
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.processSubscriptionRenewals()

    await a.tasks.refundOrphanRenewalDebits()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await refunds()).toHaveLength(0)
    expect(await marks()).toEqual([CycleExtension.EXTENDED])
    expect(daysLeft(await subscription())).toBe(30)
  })

  it('E4: a sweep ahead of the next pass leaves the debit, and that pass does not charge', async () => {
    // R15: red if canStillExtend ignores the key: the sweep refunds a cycle still on the row.
    const wallet = await debitedAndRejected()

    await a.tasks.refundOrphanRenewalDebits()

    expect(await refunds()).toHaveLength(0)
    expect(await marks()).toEqual([CycleExtension.PENDING])

    renewPlan.mockResolvedValue(true)
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.processSubscriptionRenewals()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await renewalDebits()).toHaveLength(1)
  })

  it('E5: two sweeps at once on two instances leave one credit, mark and audit', async () => {
    // R15: red if the sweep takes no lock: both read pending and both write the audit row.
    const wallet = await debitedAndRejected()
    await buy(wallet.id, 'loc105-e5')

    await Promise.all([a.tasks.refundOrphanRenewalDebits(), b.tasks.refundOrphanRenewalDebits()])

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await refunds()).toHaveLength(1)
    expect(await marks()).toEqual([CycleExtension.REFUNDED])
    expect(await audits()).toBe(1)
  })

  it('E6: a sweep during a pass waits for the lock and decides on what the pass left', async () => {
    // R15: red if the sweep decides on the debit it listed: pending, on a date already moved.
    const wallet = await debitedAndRejected()
    const gate = createGate()
    renewPlan.mockImplementation(async () => {
      gate.arrive()
      await gate.wait
      return true
    })
    sweepOnlyBrands(a, [BRAND_ID])
    const pass = a.tasks.processSubscriptionRenewals()
    await gate.reached

    const sweep = b.tasks.refundOrphanRenewalDebits()
    expect(await someoneWaitsOnAdvisoryLock(a.dataSource)).toBe(true)
    gate.release()
    await Promise.all([pass, sweep])

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await refunds()).toHaveLength(0)
    expect(await marks()).toEqual([CycleExtension.EXTENDED])
  })

  it('E7: a pending cancellation keeps the debit, and reactivating extends with no new charge', async () => {
    // R15: red if canStillExtend asks for autoRenew: the debit goes back and the cycle is free.
    const wallet = await debitedAndRejected()
    await subscriptions().cancel(BRAND_ID, { reason: 'test', triggeredBy: 'user-loc105' })

    await a.tasks.refundOrphanRenewalDebits()

    expect(await refunds()).toHaveLength(0)

    await subscriptions().reactivate(BRAND_ID, 'user-loc105')
    renewPlan.mockResolvedValue(true)
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.processSubscriptionRenewals()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await renewalDebits()).toHaveLength(1)
    expect(daysLeft(await subscription())).toBe(30)
  })

  it('E8: a row closed by its cancellation on the same date gets the debit back once', async () => {
    // R15: red if canStillExtend ignores the status: a closed row looks like it can still extend.
    const wallet = await debitedAndRejected()
    await cancelAndClose()

    await a.tasks.refundOrphanRenewalDebits()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
    expect(await refunds()).toHaveLength(1)
  })

  it('E9: a closed wallet is reopened to take the credit', async () => {
    // R15: red without reopenClosed: credit refuses a closed wallet and the debit stays pending.
    const wallet = await debitedAndRejected()
    await cancelAndClose()
    await a.dataSource
      .getRepository(Wallet)
      .update({ id: wallet.id }, { status: WalletStatus.CLOSED })

    await a.tasks.refundOrphanRenewalDebits()

    const stored = await a.dataSource.getRepository(Wallet).findOneByOrFail({ id: wallet.id })
    expect(stored.status).toBe(WalletStatus.ACTIVE)
    expect(Number(stored.balance)).toBe(BALANCE)
    expect(
      await a.dataSource
        .getRepository(AuditLog)
        .countBy({ action: 'wallet_reopened', entityId: wallet.id }),
    ).toBe(1)
  })

  it('E10: a credit that fails leaves the debit pending, and the next sweep credits once', async () => {
    // R15: red if the error from credit is ignored: the debit is marked with no money back.
    const wallet = await debitedAndRejected()
    await buy(wallet.id, 'loc105-e10')
    // R17: a database failure inside the credit transaction cannot be provoked on demand.
    jest.spyOn(a.wallet, 'credit').mockResolvedValueOnce({ error: 'connection lost' } as any)

    await a.tasks.refundOrphanRenewalDebits()

    expect(await refunds()).toHaveLength(0)
    expect(await marks()).toEqual([CycleExtension.PENDING])
    expect(await audits()).toBe(0)

    await a.tasks.refundOrphanRenewalDebits()

    expect(await refunds()).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('E11: a crash after the credit does not credit again, and the debit ends refunded', async () => {
    // R15: red if the credit carries no idempotency key: the retry credits a second time.
    const wallet = await debitedAndRejected()
    await buy(wallet.id, 'loc105-e11')
    // R17: a crash exactly between the credit and the mark cannot be provoked on demand.
    jest
      .spyOn(a.dataSource.getRepository(Transaction), 'update')
      .mockRejectedValueOnce(new Error('connection lost'))

    await a.tasks.refundOrphanRenewalDebits()

    expect(await marks()).toEqual([CycleExtension.PENDING])
    expect(await refunds()).toHaveLength(1)

    await a.tasks.refundOrphanRenewalDebits()

    expect(await refunds()).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await marks()).toEqual([CycleExtension.REFUNDED])
  })

  it('E12: a cycle debit with no mark is left alone', async () => {
    // R15: red if the sweep drops the mark filter and its recheck: an extended debit goes back.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const sub = await seedSubscription(a.dataSource, BRAND_ID, { walletId: wallet.id })
    await a.dataSource.getRepository(Transaction).save(
      a.dataSource.getRepository(Transaction).create({
        walletId: wallet.id,
        brandId: BRAND_ID,
        type: TransactionType.DEBIT,
        amount: PLAN_PRICE,
        balanceBefore: BALANCE + PLAN_PRICE,
        balanceAfter: BALANCE,
        referenceType: 'subscription',
        referenceId: sub.id,
        idempotencyKey: `subscription:${sub.id}:2020-01-01T00:00:00.000Z`,
      }),
    )

    await a.tasks.refundOrphanRenewalDebits()

    expect(await refunds()).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('E13: a trial whose renewal was rejected keeps the debit and extends with no new charge', async () => {
    // R15: red if canStillExtend leaves trial out: the debit goes back and the next pass is free.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await seedSubscription(a.dataSource, BRAND_ID, {
      walletId: wallet.id,
      status: SubscriptionStatus.TRIAL,
    })
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.processTrialConversions()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)

    await a.tasks.refundOrphanRenewalDebits()

    expect(await refunds()).toHaveLength(0)

    renewPlan.mockResolvedValue(true)
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.processTrialConversions()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(await renewalDebits()).toHaveLength(1)
    expect((await subscription()).status).toBe(SubscriptionStatus.ACTIVE)
  })

  it('E14: a pass does not extend on a debit already refunded', async () => {
    // R15: red if renewFromWallet drops its guard: the existing key counts and the cycle is free.
    // The refunded mark on a live row on the same date is written by hand: no known path reaches it.
    const wallet = await debitedAndRejected()
    const [debit] = await renewalDebits()
    await markCycleDebit(
      a.dataSource.getRepository(Transaction),
      { id: debit.id },
      CycleExtension.REFUNDED,
    )
    renewPlan.mockClear()
    renewPlan.mockResolvedValue(true)
    const before = (await subscription()).nextBillingDate
    const logSpy = jest.spyOn(logger, 'log')

    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.processSubscriptionRenewals()

    expect(renewPlan).not.toHaveBeenCalled()
    expect((await subscription()).nextBillingDate).toEqual(before)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(logSpy).toHaveBeenCalledWith('error', expect.stringContaining('already refunded'))
  })

  it('E15: a purchase with another wallet does not divert the credit', async () => {
    // R15: red if the credit goes to the wallet of the row: the paying wallet stays charged.
    const wallet = await debitedAndRejected()
    const repo = a.dataSource.getRepository(Wallet)
    const other = await repo.save(
      repo.create({
        brandId: BRAND_ID,
        userId: BRAND_ID,
        provider: 'internal-other',
        currency: 'COP',
        balance: BALANCE,
        status: WalletStatus.ACTIVE,
      }),
    )
    await buy(other.id, 'loc105-e15')
    expect((await subscription()).walletId).toBe(other.id)

    await a.tasks.refundOrphanRenewalDebits()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
    expect(await balanceOf(a.dataSource, other.id)).toBe(BALANCE - PLAN_PRICE)
  })
})
