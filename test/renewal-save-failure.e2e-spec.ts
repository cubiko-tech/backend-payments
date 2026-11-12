import { Repository } from 'typeorm'

import { ClientRolesService } from '../src/client/client-roles.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { logger } from '../src/shared/logger/logger'
import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { CycleExtension } from '../src/tasks/renewal-debit-refund'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  daysLeft,
  elapseRetryBackoff,
  loseNextCommitAnswer,
  rivalWaitsOrEnds,
  seedSubscription,
  sweepOnlyBrands,
} from './support/plan-lock.fixture'
import {
  balanceOf,
  cleanBrand,
  createGate,
  planCheckout,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7108001-2222-4333-8444-555555555555'
const BALANCE = 100000
const CHARGED_ONCE = BALANCE - PLAN_PRICE

/** Rejects each call of `method` that `decide` picks; the rest reach PostgreSQL. */
function failWrites(method: 'save' | 'update', decide: (repo: Repository<any>) => boolean) {
  const write = Repository.prototype[method]
  // R17: a database failure exactly at this statement cannot be provoked on demand.
  return jest.spyOn(Repository.prototype, method as any).mockImplementation(async function (
    this: Repository<any>,
    ...args: any[]
  ) {
    if (decide(this)) throw new Error('connection lost')
    return (write as any).apply(this, args)
  } as any)
}

/** Fails the first writes of the row: the extension, then the record of the failed attempt. */
function failFirstRowWrites(times: number) {
  let left = times
  return failWrites('update', (repo) => repo.target === Subscription && left-- > 0)
}

/** Every write of the extension fails, while the one that records the failed attempt goes through. */
const failExtensionWrites = () =>
  failWrites('update', (repo) => repo.target === Subscription && !!repo.manager.queryRunner)

/** A failed renewal must leave one debit, and either one extension or the money back. */
describe('A renewal whose save fails does not charge twice (PostgreSQL, LOC-108)', () => {
  let a: RaceInstance
  let b: RaceInstance
  let renewA: jest.SpyInstance
  let renewB: jest.SpyInstance
  let due: Date

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
    // R17: roles is another service, and it accepts the renewal in every case here.
    renewA = jest
      .spyOn(a.moduleRef.get(ClientRolesService), 'renewPlanForBrand')
      .mockResolvedValue(true)
    renewB = jest
      .spyOn(b.moduleRef.get(ClientRolesService), 'renewPlanForBrand')
      .mockResolvedValue(true)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanAll()
    await stopInstance(a)
    await stopInstance(b)
  })

  const subscription = async () =>
    (await a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID }))!

  const debits = () =>
    a.dataSource.getRepository(Transaction).findBy({
      brandId: BRAND_ID,
      type: TransactionType.DEBIT,
      referenceType: 'subscription',
    })

  const marks = async () => (await debits()).map((debit) => debit.metadata?.cycleExtension)

  const refunds = () =>
    a.dataSource
      .getRepository(Transaction)
      .findBy({ brandId: BRAND_ID, type: TransactionType.CREDIT, category: 'refund' })

  const seedDueRow = async () => {
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const sub = await seedSubscription(a.dataSource, BRAND_ID, { walletId: wallet.id })
    due = sub.nextBillingDate
    return wallet
  }

  const renewalPass = (instance: RaceInstance = a) => {
    sweepOnlyBrands(instance, [BRAND_ID])
    return instance.tasks.processSubscriptionRenewals()
  }

  /** The cron pass that charged the row while the save of the row failed once. */
  const renewalWithFailedSave = async () => {
    const wallet = await seedDueRow()
    const saves = failFirstRowWrites(1)
    await renewalPass()
    saves.mockRestore()
    return wallet
  }

  const retryAfterBackoff = async () => {
    await elapseRetryBackoff(a.dataSource, (await subscription()).id)
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.retryFailedPayments()
  }

  const expectOneChargeAndOneExtension = async (walletId: string) => {
    expect(await balanceOf(a.dataSource, walletId)).toBe(CHARGED_ONCE)
    expect(await debits()).toHaveLength(1)
    expect(await marks()).toEqual([CycleExtension.EXTENDED])
    const sub = await subscription()
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE)
    expect(sub.retryCount).toBe(0)
    expect(daysLeft(sub)).toBe(30)
  }

  it('E1: the retry after a failed save extends without a second charge', async () => {
    // R15: red if sub takes the new date before the commit: no failure is kept and the retry skips it.
    const wallet = await renewalWithFailedSave()

    await retryAfterBackoff()

    await expectOneChargeAndOneExtension(wallet.id)
  })

  it('E1: the hourly pass ignores the backoff and extends without a second charge', async () => {
    // R15: red if the hourly pass leaves past-due rows out: the row stays on its cycle, past due.
    const wallet = await renewalWithFailedSave()

    await renewalPass()

    await expectOneChargeAndOneExtension(wallet.id)
  })

  it('E10: a commit whose answer is lost does not charge again on the retry', async () => {
    // R15: red if the failure ignores the cycle read: past due on the new date, a new debit key.
    const wallet = await seedDueRow()
    renewA.mockImplementation(async () => {
      loseNextCommitAnswer(a)
      return true
    })

    await renewalPass()
    renewA.mockResolvedValue(true)

    await expectOneChargeAndOneExtension(wallet.id)

    await retryAfterBackoff()
    await renewalPass()

    await expectOneChargeAndOneExtension(wallet.id)
  })

  it('E2: a normal renewal leaves one debit and one extension', async () => {
    // R15: red if the extension does not mark the debit: it stays pending for the sweep.
    const wallet = await seedDueRow()

    await renewalPass()

    await expectOneChargeAndOneExtension(wallet.id)
  })

  it('E3: a failed save leaves the debit pending and the row on its cycle', async () => {
    // R15: red if the mark leaves the transaction: the debit says extended on an unmoved date.
    const wallet = await renewalWithFailedSave()

    expect(await marks()).toEqual([CycleExtension.PENDING])
    const sub = await subscription()
    expect(sub.nextBillingDate).toEqual(due)
    expect(sub.status).toBe(SubscriptionStatus.PAST_DUE)
    expect(sub.retryCount).toBe(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(CHARGED_ONCE)
  })

  it('E4: a sweep on another instance leaves the debit, and the next pass extends', async () => {
    // R15: red if the sweep skips canStillExtend: the debit goes back and the extension is free.
    const wallet = await renewalWithFailedSave()

    await b.tasks.refundOrphanRenewalDebits()

    expect(await refunds()).toHaveLength(0)
    expect(await marks()).toEqual([CycleExtension.PENDING])

    await renewalPass()

    await expectOneChargeAndOneExtension(wallet.id)
  })

  it('E5: a purchase that moves the date gets the debit back once from the sweep', async () => {
    // R15: red if the mark leaves the transaction: the sweep does not list it and 60200 remains.
    const wallet = await renewalWithFailedSave()
    await a.checkout.processCheckout(planCheckout(BRAND_ID, wallet.id, 'loc108-e5', 'dropi-roax'))
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)

    await a.tasks.refundOrphanRenewalDebits()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(CHARGED_ONCE)
    expect(await refunds()).toHaveLength(1)
    expect(await marks()).toEqual([CycleExtension.REFUNDED])
    expect(daysLeft(await subscription())).toBe(30)
  })

  it('E6: two passes at once after a failed save renew in roles only once', async () => {
    // R15: red if the pass takes no plan lock: the second one rereads the old date and renews too.
    const wallet = await renewalWithFailedSave()
    renewA.mockClear()
    const gate = createGate()
    renewA.mockImplementation(async () => {
      gate.arrive()
      await gate.wait
      return true
    })

    const first = renewalPass(a)
    await gate.reached
    const second = renewalPass(b)
    await rivalWaitsOrEnds(second, a.dataSource)
    gate.release()
    await Promise.all([first, second])

    expect(renewA.mock.calls.length + renewB.mock.calls.length).toBe(1)
    await expectOneChargeAndOneExtension(wallet.id)
  })

  it('E7: a failed RENEWED event keeps the renewal, and the retry does not charge', async () => {
    // R15: red if the event failure is rethrown: the row goes past due on the new date and pays again.
    const wallet = await seedDueRow()
    const logSpy = jest.spyOn(logger, 'log')
    let left = 1
    const saves = failWrites('save', (repo) => repo.target === SubscriptionEvent && left-- > 0)

    await renewalPass()
    saves.mockRestore()

    await expectOneChargeAndOneExtension(wallet.id)
    const { id } = await subscription()
    expect(logSpy).toHaveBeenCalledWith('error', expect.stringContaining(id))

    await retryAfterBackoff()

    await expectOneChargeAndOneExtension(wallet.id)
  })

  it('E8: a save failing on each hourly pass ends with the row closed and the debit back', async () => {
    // R15: red if the mark leaves the transaction: the sweep does not list it and the money stays.
    const wallet = await seedDueRow()
    const roles = a.moduleRef.get(ClientRolesService)
    const removePlan = jest.fn().mockResolvedValue(true)
    Object.assign(roles, { removePlanFromBrand: removePlan })
    Object.assign(a.moduleRef.get(EventBusService), {
      publishSubscriptionExpired: jest.fn(),
      notifySubscriptionExpired: jest.fn().mockResolvedValue(null),
    })
    const saves = failExtensionWrites()

    await renewalPass()
    await renewalPass()
    await renewalPass()
    saves.mockRestore()

    expect((await subscription()).retryCount).toBe(3)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(CHARGED_ONCE)

    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.expireSubscriptions()
    await a.tasks.refundOrphanRenewalDebits()

    expect((await subscription()).status).toBe(SubscriptionStatus.EXPIRED)
    expect(removePlan).toHaveBeenCalled()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
    expect(await refunds()).toHaveLength(1)
    expect(await marks()).toEqual([CycleExtension.REFUNDED])
  })

  it('E9: when recording the failure fails too, the row is untouched and the charge stays single', async () => {
    // R15: red if the mark leaves the transaction: the debit says extended on an unmoved date.
    const wallet = await seedDueRow()
    const saves = failFirstRowWrites(2)

    await expect(renewalPass()).rejects.toThrow('connection lost')
    saves.mockRestore()

    const sub = await subscription()
    expect(sub.nextBillingDate).toEqual(due)
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE)
    expect(sub.retryCount).toBe(0)
    expect(await marks()).toEqual([CycleExtension.PENDING])

    await renewalPass()

    await expectOneChargeAndOneExtension(wallet.id)
  })
})
