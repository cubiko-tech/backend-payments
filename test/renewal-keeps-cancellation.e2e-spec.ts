import { Repository } from 'typeorm'

import { ClientRolesService } from '../src/client/client-roles.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { CycleExtension } from '../src/tasks/renewal-debit-refund'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  daysLeft,
  rivalWaitsOrEnds,
  seedSubscription,
  sweepOnlyBrands,
} from './support/plan-lock.fixture'
import {
  balanceOf,
  cleanBrand,
  createGate,
  Gate,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7111001-2222-4333-8444-555555555555'
const BALANCE = 100000
const CHARGED_ONCE = BALANCE - PLAN_PRICE
const REASON = 'no longer needed'

/** A cancellation confirmed while a renewal pass waits for roles is kept (PostgreSQL, LOC-111). */
describe('A renewal does not lose a cancellation confirmed during the pass', () => {
  let a: RaceInstance
  let b: RaceInstance
  let cancellations: SubscriptionService
  let renewA: jest.SpyInstance
  let renewB: jest.SpyInstance
  let removePlan: jest.Mock
  let walletId: string
  let due: Date

  const stubDowngrade = (instance: RaceInstance) => {
    Object.assign(instance.moduleRef.get(ClientRolesService), { removePlanFromBrand: removePlan })
    // R17: Redis is remote, and no case here decides on what it publishes.
    Object.assign(instance.moduleRef.get(EventBusService), {
      publishSubscriptionExpired: jest.fn(),
      notifySubscriptionExpired: jest.fn().mockResolvedValue(null),
    })
  }

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
    const subscriptions = a.dataSource.getRepository(Subscription)
    const events = a.dataSource.getRepository(SubscriptionEvent)
    // R17: wallet rows never reach the Confio collaborators, so the real `cancel` needs none of them.
    cancellations = new SubscriptionService(
      subscriptions,
      subscriptions,
      events,
      events,
      a.dataSource,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    )
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
    // R17: roles is another service; each case decides when and how it answers.
    renewA = jest
      .spyOn(a.moduleRef.get(ClientRolesService), 'renewPlanForBrand')
      .mockResolvedValue(true)
    renewB = jest
      .spyOn(b.moduleRef.get(ClientRolesService), 'renewPlanForBrand')
      .mockResolvedValue(true)
    // The stubs are jest.fn already: spyOn returns them with the calls of the case before.
    renewA.mockClear()
    renewB.mockClear()
    removePlan = jest.fn().mockResolvedValue(true)
    stubDowngrade(a)
    stubDowngrade(b)
    b.assignPlan.mockClear()
    walletId = (await seedWallet(a.dataSource, BRAND_ID, BALANCE)).id
    due = (await seedSubscription(a.dataSource, BRAND_ID, { walletId })).nextBillingDate
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

  const renewalPass = (instance: RaceInstance = a) => {
    sweepOnlyBrands(instance, [BRAND_ID])
    return instance.tasks.processSubscriptionRenewals()
  }

  const accessSweep = (instance: RaceInstance = a) => {
    sweepOnlyBrands(instance, [BRAND_ID])
    return instance.tasks.expireCancelledSubscriptions()
  }

  const cancel = () =>
    cancellations.cancel(BRAND_ID, { reason: REASON, triggeredBy: 'user-loc111' })

  /** Starts a pass that stays inside roles, answering `answer` once the returned gate opens. */
  const passHeldInRoles = async (answer = true): Promise<[Promise<void>, Gate]> => {
    const gate = createGate()
    renewA.mockImplementation(async () => {
      gate.arrive()
      await gate.wait
      return answer
    })
    const pass = renewalPass()
    await gate.reached
    return [pass, gate]
  }

  /** The pass that charged and extended with a cancellation confirmed while it waited for roles. */
  const renewalWithCancellation = async () => {
    const [pass, gate] = await passHeldInRoles()
    await cancel()
    gate.release()
    await pass
  }

  const expectCancellationKept = async () => {
    const sub = await subscription()
    expect(sub.autoRenew).toBe(false)
    expect(sub.cancelledAt).toBeInstanceOf(Date)
    expect(sub.cancelReason).toBe(REASON)
    return sub
  }

  /** The sweep closes the row, and the debit of a cycle nobody extended goes back once. */
  const expectClosedWithMoneyBack = async () => {
    await accessSweep()
    await a.tasks.refundOrphanRenewalDebits()

    expect((await subscription()).status).toBe(SubscriptionStatus.CANCELLED)
    expect(await balanceOf(a.dataSource, walletId)).toBe(BALANCE)
    expect(await refunds()).toHaveLength(1)
    expect(await marks()).toEqual([CycleExtension.REFUNDED])
  }

  it('E1: a cancellation during the pass stays, with its one trace', async () => {
    // R15: red if the extension saves the whole row again: autoRenew goes back to true.
    await renewalWithCancellation()

    await expectCancellationKept()
    const trace = await a.dataSource.getRepository(SubscriptionEvent).countBy({
      subscriptionId: (await subscription()).id,
      eventType: SubscriptionEventType.CANCELLED,
    })
    expect(trace).toBe(1)
  })

  it('E2: the next cycle does not charge who cancelled', async () => {
    // R15: red if the extension saves the whole row again: the next pass debits a second cycle.
    await renewalWithCancellation()
    await a.dataSource.query(
      `UPDATE subscriptions SET status = 'past_due', "nextBillingDate" = NOW() - INTERVAL '1 hour',
       "updatedAt" = NOW() - INTERVAL '10 days' WHERE "brandId" = $1`,
      [BRAND_ID],
    )

    await renewalPass()
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.retryFailedPayments()

    expect(await debits()).toHaveLength(1)
    expect(await balanceOf(a.dataSource, walletId)).toBe(CHARGED_ONCE)
    expect(renewA).toHaveBeenCalledTimes(1)
  })

  it('E3: the paid renewal keeps its period through the access sweep', async () => {
    // R15: red if the cut stays at the old period: the sweep retires the cycle just paid for.
    await renewalWithCancellation()

    await accessSweep()

    const sub = await expectCancellationKept()
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE)
    expect(daysLeft(sub)).toBe(30)
    expect(sub.accessEndsAt).toEqual(sub.currentPeriodEnd)
    expect(removePlan).not.toHaveBeenCalled()
    expect(await marks()).toEqual([CycleExtension.EXTENDED])
  })

  it('E4: a renewal without a cancellation stays as it was', async () => {
    // R15: red if the cut is written on every row: a renewing row gets a date to be retired on.
    await renewalPass()

    const sub = await subscription()
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE)
    expect(sub.retryCount).toBe(0)
    expect(sub.autoRenew).toBe(true)
    expect(sub.cancelledAt).toBeNull()
    expect(sub.accessEndsAt).toBeNull()
    expect(daysLeft(sub)).toBe(30)
    expect(await marks()).toEqual([CycleExtension.EXTENDED])
  })

  it('E5: a failed charge after the cancellation records the failure and keeps it', async () => {
    // R15: red if the failure saves the whole row again: autoRenew goes back to true.
    await a.dataSource.query(`UPDATE wallets SET balance = 0 WHERE id = $1`, [walletId])
    const roles = a.moduleRef.get(ClientRolesService)
    const gate = createGate()
    jest.spyOn(roles, 'getPlanPrice').mockImplementation(async () => {
      gate.arrive()
      await gate.wait
      return PLAN_PRICE
    })

    const pass = renewalPass()
    await gate.reached
    await cancel()
    gate.release()
    await pass

    const sub = await expectCancellationKept()
    expect(sub.status).toBe(SubscriptionStatus.PAST_DUE)
    expect(sub.retryCount).toBe(1)
    expect(await debits()).toHaveLength(0)
  })

  it('E6: roles refusing leaves the cancellation, and the debit goes back once (regression)', async () => {
    // R15: red if a refusal from roles no longer stops the pass: the row extends on it.
    const [pass, gate] = await passHeldInRoles(false)
    await cancel()
    gate.release()
    await pass

    const sub = await expectCancellationKept()
    expect(sub.nextBillingDate).toEqual(due)
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE)
    expect(await marks()).toEqual([CycleExtension.PENDING])

    await expectClosedWithMoneyBack()
  })

  it('E7: a sweep that closes the row during the pass is not undone', async () => {
    // R15: red if the extension does not require a live row: it revives the closed row.
    const [pass, gate] = await passHeldInRoles()
    await cancel()
    await accessSweep(b)
    expect((await subscription()).status).toBe(SubscriptionStatus.CANCELLED)

    gate.release()
    await pass

    const sub = await subscription()
    expect(sub.status).toBe(SubscriptionStatus.CANCELLED)
    expect(sub.nextBillingDate).toEqual(due)
    expect(await marks()).toEqual([CycleExtension.PENDING])

    await a.tasks.refundOrphanRenewalDebits()

    expect(await balanceOf(a.dataSource, walletId)).toBe(BALANCE)
    expect(await refunds()).toHaveLength(1)
    expect(await marks()).toEqual([CycleExtension.REFUNDED])
  })

  it('E9: a pass on another instance waits, and roles renews once (regression)', async () => {
    // R15: red if the pass takes no plan lock: the second one renews in roles too.
    const [pass, gate] = await passHeldInRoles()
    const second = renewalPass(b)
    await rivalWaitsOrEnds(second, a.dataSource)
    await cancel()
    gate.release()
    await Promise.all([pass, second])

    await expectCancellationKept()
    expect(renewA.mock.calls.length + renewB.mock.calls.length).toBe(1)
    expect(await debits()).toHaveLength(1)
    expect(await balanceOf(a.dataSource, walletId)).toBe(CHARGED_ONCE)
  })

  it('E10: a failed extension after the cancellation keeps it, and the debit goes back once', async () => {
    // R15: red if the failure saves the whole row again: autoRenew goes back to true.
    const [pass, gate] = await passHeldInRoles()
    await cancel()
    let left = 1
    const update = Repository.prototype.update
    // R17: a database failure exactly at this statement cannot be provoked on demand.
    const writes = jest.spyOn(Repository.prototype, 'update').mockImplementation(async function (
      this: Repository<any>,
      ...args: any[]
    ) {
      if (this.target === Subscription && left-- > 0) throw new Error('connection lost')
      return (update as any).apply(this, args)
    } as any)
    gate.release()
    await pass
    writes.mockRestore()

    const sub = await expectCancellationKept()
    expect(sub.status).toBe(SubscriptionStatus.PAST_DUE)
    expect(sub.retryCount).toBe(1)
    expect(sub.nextBillingDate).toEqual(due)

    await renewalPass()

    expect(await debits()).toHaveLength(1)
    await expectClosedWithMoneyBack()
  })

  it('E11: an extension that lands while the sweep downgrades gets the plan back', async () => {
    // R15: red if the cut stays at the old period: the sweep closes the row it just downgraded.
    const [pass, renewal] = await passHeldInRoles()
    await cancel()
    const downgrade = createGate()
    removePlan.mockImplementation(async () => {
      downgrade.arrive()
      await downgrade.wait
      return true
    })
    const sweep = accessSweep(b)
    await downgrade.reached

    renewal.release()
    await pass
    downgrade.release()
    await sweep

    const sub = await expectCancellationKept()
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE)
    expect(sub.accessEndsAt).toEqual(sub.currentPeriodEnd)
    expect(b.assignPlan).toHaveBeenLastCalledWith(BRAND_ID, sub.planSlug, sub.currentPeriodEnd)
  })
})
