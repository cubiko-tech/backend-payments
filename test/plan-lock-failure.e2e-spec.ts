import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../src/subscription/entities/subscriptionEvent.entity'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  daysLeft,
  elapseRetryBackoff,
  failPlanLockOf,
  seedSubscription,
  sweepOnlyBrands,
} from './support/plan-lock.fixture'
import {
  balanceOf,
  cleanBrand,
  findPaymentByKey,
  movements,
  planCheckout,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
  sweepAfter,
} from './support/wallet-race.fixture'
import { lockBrandPlan } from '../src/checkout/wallet-payment-close'

const BRAND_ID = 'a7880002-2222-4333-8444-555555555555'
const OTHER_BRAND_ID = 'a7880003-2222-4333-8444-555555555555'
const BALANCE = 100000
const TEN_MINUTES_MS = 10 * 60 * 1000
const LOCK_WAIT_MARGIN_MS = 60_000

type CronPass = 'processSubscriptionRenewals' | 'retryFailedPayments' | 'processTrialConversions'

const CRON_PASSES: { pass: CronPass; status: SubscriptionStatus }[] = [
  { pass: 'processSubscriptionRenewals', status: SubscriptionStatus.ACTIVE },
  { pass: 'retryFailedPayments', status: SubscriptionStatus.PAST_DUE },
  { pass: 'processTrialConversions', status: SubscriptionStatus.TRIAL },
]

/** A lock that cannot be taken charged nothing, so it must not look like a failed payment. */
describe('The plan lock failing or timing out (PostgreSQL, LOC-88)', () => {
  let a: RaceInstance

  beforeAll(async () => {
    a = await startInstance()
  })

  beforeEach(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await cleanBrand(a.dataSource, OTHER_BRAND_ID)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await cleanBrand(a.dataSource, OTHER_BRAND_ID)
    await stopInstance(a)
  })

  const row = async (brandId: string) =>
    (await a.dataSource.getRepository(Subscription).findOneBy({ brandId }))!

  /** A row of each brand due for `pass`, each with its wallet. */
  const seedDueRows = async (status: SubscriptionStatus) => {
    const seedOne = async (brandId: string) => {
      const wallet = await seedWallet(a.dataSource, brandId, BALANCE)
      const sub = await seedSubscription(a.dataSource, brandId, { walletId: wallet.id, status })
      await elapseRetryBackoff(a.dataSource, sub.id)
      return { wallet, sub }
    }
    return { target: await seedOne(BRAND_ID), other: await seedOne(OTHER_BRAND_ID) }
  }

  const expectUntouched = async (
    { wallet, sub }: Awaited<ReturnType<typeof seedDueRows>>['target'],
    status: SubscriptionStatus,
  ) => {
    const after = await row(BRAND_ID)
    expect(after.status).toBe(status)
    expect(after.retryCount).toBe(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
    const failures = await a.dataSource.getRepository(SubscriptionEvent).countBy({
      subscriptionId: sub.id,
      eventType: SubscriptionEventType.PAYMENT_FAILED,
    })
    expect(failures).toBe(0)
    expect(a.moduleRef.get(EventBusService).notifyPaymentFailed).not.toHaveBeenCalledWith(
      BRAND_ID,
      expect.anything(),
      expect.anything(),
    )
  }

  it.each(CRON_PASSES)(
    'E5: $pass counts a lock it could not take as no failed payment and goes on',
    async ({ pass, status }) => {
      // R15: red if a lock failure reaches handleRenewalFailure: retryCount rises and a failure is told.
      const { target, other } = await seedDueRows(status)
      failPlanLockOf(a, BRAND_ID)
      sweepOnlyBrands(a, [BRAND_ID, OTHER_BRAND_ID])

      await a.tasks[pass]()

      await expectUntouched(target, status)
      expect(await balanceOf(a.dataSource, other.wallet.id)).toBe(BALANCE - PLAN_PRICE)
    },
  )

  it.each(CRON_PASSES)(
    'E5: $pass counts a failed reread as no failed payment and leaves the lock released',
    async ({ pass, status }) => {
      // R15: red if a reread failure keeps the lock: the next pass on the row never takes it.
      const { target } = await seedDueRows(status)
      const repo = (a.tasks as any).subscriptionRepo
      jest.spyOn(repo, 'findOne').mockRejectedValueOnce(new Error('Reread failed'))
      sweepOnlyBrands(a, [BRAND_ID])

      await a.tasks[pass]()
      await expectUntouched(target, status)

      sweepOnlyBrands(a, [BRAND_ID])
      await a.tasks[pass]()
      expect(await balanceOf(a.dataSource, target.wallet.id)).toBe(BALANCE - PLAN_PRICE)
      expect(daysLeft(await row(BRAND_ID))).toBe(30)
    },
  )

  it(
    'E9: a checkout that waits too long gives up its connection and leaves the payment to the sweep',
    async () => {
      // R15: red if lockBrandPlan stops setting lock_timeout: the checkout waits forever on its connection.
      const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
      const holder = a.dataSource.createQueryRunner()
      await holder.connect()
      await holder.startTransaction()
      try {
        await lockBrandPlan(holder, BRAND_ID)
        await expect(
          a.checkout.processCheckout(planCheckout(BRAND_ID, wallet.id, 'loc88-e9', 'dropi-roax')),
        ).rejects.toThrow('lock timeout')
      } finally {
        await holder.rollbackTransaction()
        await holder.release()
      }

      const payment = await findPaymentByKey(a.dataSource, 'loc88-e9')
      expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PROCESSING)
      expect(await movements(a.dataSource, payment.id, TransactionType.DEBIT)).toHaveLength(1)

      await sweepAfter(a, payment.id, TEN_MINUTES_MS)
      expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
      expect(daysLeft(await row(BRAND_ID))).toBe(30)
    },
    LOCK_WAIT_MARGIN_MS,
  )
})
