import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../src/subscription/entities/subscriptionEvent.entity'
import { seedExternalPurchase } from './support/external-purchase.fixture'
import {
  DAY_MS,
  daysLeft,
  elapseRetryBackoff,
  parkFirstSubscriptionSave,
  rivalWaitsOrEnds,
  seedSubscription,
  sweepOnlyBrands,
} from './support/plan-lock.fixture'
import {
  balanceOf,
  cleanBrand,
  createGate,
  findPaymentByKey,
  parkFirstCall,
  planCheckout,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  someoneWaitsOnAdvisoryLock,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7880001-2222-4333-8444-555555555555'
const BALANCE = 100000
const PLAN = 'dropi-roax'

/** Checkouts and crons on one plan, on two instances: what they charge and the days they leave. */
describe('Purchases and crons of one plan share one lock (PostgreSQL, LOC-88)', () => {
  let a: RaceInstance
  let b: RaceInstance

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND_ID))

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
    await stopInstance(b)
  })

  const buy = (instance: RaceInstance, walletId: string, key: string) =>
    instance.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, PLAN))

  const subscription = async () =>
    (await a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID }))!

  const cronRenewals = (subscriptionId: string) =>
    a.dataSource.getRepository(SubscriptionEvent).countBy({
      subscriptionId,
      eventType: SubscriptionEventType.RENEWED,
      triggeredBy: 'system',
    })

  /** A cron pass on instance `b` while a checkout on `a` holds the lock before reading the row. */
  const cronWhileCheckoutHoldsLock = async (walletId: string, cron: () => Promise<void>) => {
    const gate = createGate()
    parkFirstCall(a.checkout, 'createOrRenewSubscription', gate)
    const purchase = buy(a, walletId, 'loc88-holder')
    await gate.reached
    sweepOnlyBrands(b, [BRAND_ID])
    const pass = cron()
    expect(await someoneWaitsOnAdvisoryLock(a.dataSource)).toBe(true)
    gate.release()
    await Promise.all([purchase, pass])
  }

  /** A checkout on `b` while a cron pass on `a` is parked between reading its row and saving it. */
  const checkoutWhileCronSaves = async (walletId: string, cron: () => Promise<void>) => {
    const gate = createGate()
    parkFirstSubscriptionSave(gate)
    sweepOnlyBrands(a, [BRAND_ID])
    const pass = cron()
    await gate.reached
    const purchase = buy(b, walletId, 'loc88-rival')
    await rivalWaitsOrEnds(purchase, a.dataSource)
    gate.release()
    await Promise.all([pass, purchase])
  }

  it('E1: two wallet checkouts of the active plan at once are both charged and both add days', async () => {
    // R15: red if closeWalletPayment drops lockBrandPlan: the second save overwrites and 40 days remain.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await seedSubscription(a.dataSource, BRAND_ID, {
      walletId: wallet.id,
      currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
      nextBillingDate: new Date(Date.now() + 10 * DAY_MS),
    })
    const gate = createGate()
    parkFirstSubscriptionSave(gate)

    const first = buy(a, wallet.id, 'loc88-e1-a')
    await gate.reached
    const second = buy(b, wallet.id, 'loc88-e1-b')
    await rivalWaitsOrEnds(second, a.dataSource)
    gate.release()
    await Promise.all([first, second])

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
    expect(daysLeft(await subscription())).toBe(70)
  })

  it('E2: a checkout during a renewal waits for it, and both periods add up', async () => {
    // R15: red if the cron locks another key: the checkout does not wait, and 30 days remain.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await seedSubscription(a.dataSource, BRAND_ID, { walletId: wallet.id })

    await checkoutWhileCronSaves(wallet.id, () => a.tasks.processSubscriptionRenewals())

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
    expect(daysLeft(await subscription())).toBe(60)
  })

  it('E3: a renewal during a checkout waits, rereads the row and charges nothing', async () => {
    // R15: red if the renewal does not reread after locking: it charges a period already paid.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const sub = await seedSubscription(a.dataSource, BRAND_ID, { walletId: wallet.id })

    await cronWhileCheckoutHoldsLock(wallet.id, () => b.tasks.processSubscriptionRenewals())

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(daysLeft(await subscription())).toBe(30)
    expect(await cronRenewals(sub.id)).toBe(0)
  })

  it('E4: a payment retry during a checkout waits, rereads the row and charges nothing', async () => {
    // R15: red if the retry drops its lock or its reread: it charges the period the checkout paid.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const sub = await seedSubscription(a.dataSource, BRAND_ID, {
      walletId: wallet.id,
      status: SubscriptionStatus.PAST_DUE,
    })
    await elapseRetryBackoff(a.dataSource, sub.id)

    await cronWhileCheckoutHoldsLock(wallet.id, () => b.tasks.retryFailedPayments())

    const after = await subscription()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(after.status).toBe(SubscriptionStatus.ACTIVE)
    expect(after.retryCount).toBe(0)
    expect(daysLeft(after)).toBe(30)
  })

  it('E6: an external and two wallet purchases of one plan add the days of all three', async () => {
    // R15: red if the external close drops lockBrandPlan: its save is overwritten and days are lost.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await seedSubscription(a.dataSource, BRAND_ID, {
      walletId: wallet.id,
      currentPeriodEnd: new Date(Date.now() + 10 * DAY_MS),
      nextBillingDate: new Date(Date.now() + 10 * DAY_MS),
    })
    const external = await seedExternalPurchase(a.dataSource, BRAND_ID, PLAN)
    const gate = createGate()
    parkFirstSubscriptionSave(gate)

    const first = buy(a, wallet.id, 'loc88-e6-a')
    await gate.reached
    const confirming = b.checkout.completeExternalPayment(external.id)
    await rivalWaitsOrEnds(confirming, a.dataSource)
    const third = buy(b, wallet.id, 'loc88-e6-c')
    await rivalWaitsOrEnds(third, a.dataSource)
    gate.release()
    await Promise.all([first, confirming, third])

    const firstPayment = await findPaymentByKey(a.dataSource, 'loc88-e6-a')
    expect(await statusOf(a.dataSource, firstPayment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.COMPLETED)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
    expect(daysLeft(await subscription())).toBe(100)
  })

  it('E7: a checkout during a trial conversion waits for it, and both periods add up', async () => {
    // R15: red if the trial pass drops its lock: the checkout does not wait, and 30 days remain.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await seedSubscription(a.dataSource, BRAND_ID, {
      walletId: wallet.id,
      status: SubscriptionStatus.TRIAL,
    })

    await checkoutWhileCronSaves(wallet.id, () => a.tasks.processTrialConversions())

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
    expect(daysLeft(await subscription())).toBe(60)
  })

  it('E7b: a wallet trial conversion during a checkout rereads the row and charges nothing', async () => {
    // R15: red if the trial pass does not reread after locking: it charges a period already paid.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const sub = await seedSubscription(a.dataSource, BRAND_ID, {
      walletId: wallet.id,
      status: SubscriptionStatus.TRIAL,
    })

    await cronWhileCheckoutHoldsLock(wallet.id, () => b.tasks.processTrialConversions())

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    expect(daysLeft(await subscription())).toBe(30)
    expect(await cronRenewals(sub.id)).toBe(0)
  })

  it('E8: an external trial conversion during a checkout leaves the paid row as it is', async () => {
    // R15: red if the trial pass does not reread: its charge saves past_due over the paid row.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await seedSubscription(a.dataSource, BRAND_ID, {
      provider: 'confio' as any,
      status: SubscriptionStatus.TRIAL,
    })

    await cronWhileCheckoutHoldsLock(wallet.id, () => b.tasks.processTrialConversions())

    const after = await subscription()
    expect(after.status).toBe(SubscriptionStatus.ACTIVE)
    expect(daysLeft(after)).toBe(30)
  })
})
