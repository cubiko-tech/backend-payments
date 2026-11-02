import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../src/subscription/entities/subscriptionEvent.entity'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  backdateEvent,
  seedExternalPurchase,
  settleBrand,
  subscriptionOf,
} from './support/external-purchase.fixture'
import {
  cleanBrand,
  findPaymentByKey,
  movements,
  planCheckout,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
  sweepAfter,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7101003-2222-4333-8444-555555555555'
const BALANCE = 100000
const PLAN_A = 'dropi-roax'
const PLAN_B = 'dropi-roax-plus'

/** How a purchase ends by what it applied, what it used and what became of its rival. */
describe('What a purchase that lost its plan ends as (PostgreSQL, LOC-101)', () => {
  let a: RaceInstance

  beforeAll(async () => {
    a = await startInstance()
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND_ID))

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
  })

  const external = (plan: string, age: string) =>
    seedExternalPurchase(a.dataSource, BRAND_ID, plan, { age })
  const confirm = (id: string) => a.checkout.completeExternalPayment(id, { source: 'webhook' })
  const creditsOf = (id: string) => movements(a.dataSource, id, TransactionType.CREDIT)
  const subscription = async () => (await subscriptionOf(a.dataSource, BRAND_ID))!

  /** Plan applied and the confirmation died in the invoice, so the purchase stays `processing`. */
  const appliedWithoutCompleting = async (id: string) => {
    const invoices = a.moduleRef.get(InvoiceService) as any
    // R17: A crash between applying the plan and completing cannot be provoked on demand.
    invoices.create.mockRejectedValueOnce(new Error('Invoice crash'))
    await expect(confirm(id)).rejects.toThrow('Invoice crash')
  }

  /** What `issueExternalCharge` leaves: a past-due subscription and the link's failure event. */
  const renewalLink = async (plan: string, age: string) => {
    const seed = await external(plan, '60 days')
    await confirm(seed.id)
    const sub = await subscription()
    await a.dataSource.query(`UPDATE subscriptions SET status = $1 WHERE id = $2`, [
      SubscriptionStatus.PAST_DUE,
      sub.id,
    ])
    const link = await external(plan, age)
    const events = a.dataSource.getRepository(SubscriptionEvent)
    await events.save(
      events.create({
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.PAYMENT_FAILED,
        fromStatus: SubscriptionStatus.ACTIVE,
        toStatus: SubscriptionStatus.PAST_DUE,
        triggeredBy: 'system',
        paymentId: link.id,
        reason: 'Link de cobro stripe emitido',
      }),
    )
    return { link, sub, seed }
  }

  it('H1-c credits a renewal link paid after a newer plan, whatever its link event', async () => {
    // R15: red if any event counts as applying: the link stays completed with no credit and no days.
    const { link } = await renewalLink(PLAN_A, '3 days')
    await backdateEvent(a.dataSource, link.id, '3 days')
    const newer = await external(PLAN_B, '2 days')
    await confirm(newer.id)

    await confirm(link.id)

    expect(await statusOf(a.dataSource, link.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(link.id)).toHaveLength(1)
    const sub = await subscription()
    expect(sub.planSlug).toBe(PLAN_B)
    expect(sub.lastPaymentId).toBe(newer.id)
  })

  it('T6-link renews the subscription when a renewal link with no rival is paid', async () => {
    // R15: red if any event stops the renewal: the link is completed, charged and adds no days.
    const { link, sub } = await renewalLink(PLAN_A, '1 hour')

    await confirm(link.id)

    expect(await statusOf(a.dataSource, link.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(link.id)).toHaveLength(0)
    const renewed = await subscription()
    expect(renewed.status).toBe(SubscriptionStatus.ACTIVE)
    expect(renewed.lastPaymentId).toBe(link.id)
    expect(renewed.currentPeriodEnd.getTime()).toBeGreaterThan(sub.currentPeriodEnd.getTime())
  })

  it('H1-d does not hand back a purchase with its days when a stuck one comes back', async () => {
    // R15: red if coming back yields again: the older one is credited and its days stay.
    const older = await external(PLAN_A, '3 days')
    const stuck = await external(PLAN_B, '2 days 23 hours')
    await appliedWithoutCompleting(stuck.id)
    await backdateEvent(a.dataSource, stuck.id, '2 days')
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await a.checkout.processCheckout(planCheckout(BRAND_ID, wallet.id, 'same-as-older', PLAN_A))
    const periodBefore = (await subscription()).currentPeriodEnd.getTime()
    await confirm(older.id)
    const extended = (await subscription()).currentPeriodEnd.getTime()
    expect(extended).toBeGreaterThan(periodBefore)

    await settleBrand(a, BRAND_ID)
    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(older.id)).toHaveLength(0)
    expect((await subscription()).currentPeriodEnd.getTime()).toBe(extended)
    expect(await statusOf(a.dataSource, stuck.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(stuck.id)).toHaveLength(0)
  })

  it('T8-late credits a purchase replaced within the window although judged days later', async () => {
    // R15: red if the window is measured against now: charged, with its days replaced in an hour.
    const stuck = await external(PLAN_A, '4 days')
    await appliedWithoutCompleting(stuck.id)
    const newer = await external(PLAN_B, '3 days')
    await confirm(newer.id)
    await backdateEvent(a.dataSource, stuck.id, '3 days 1 hour')
    await backdateEvent(a.dataSource, newer.id, '3 days')

    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, stuck.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(stuck.id)).toHaveLength(1)
    expect((await subscription()).planSlug).toBe(PLAN_B)
  })

  it('T8-refunded credits it too when the purchase that replaced it was handed back', async () => {
    // R15: red if the winner being refunded revives it: it would complete with someone else's plan.
    const stuck = await external(PLAN_A, '50 minutes')
    await appliedWithoutCompleting(stuck.id)
    const winner = await external(PLAN_B, '40 minutes')
    const newest = await external(PLAN_A, '30 minutes')
    await confirm(winner.id)
    // Only the refunded winner replaced it in time: the newest change falls outside the window.
    await backdateEvent(a.dataSource, stuck.id, '30 hours')
    await backdateEvent(a.dataSource, winner.id, '20 hours')
    await confirm(newest.id)
    await confirm(winner.id)
    expect(await statusOf(a.dataSource, winner.id)).toBe(PaymentStatus.REFUNDED)

    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, stuck.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(stuck.id)).toHaveLength(1)
    expect(await statusOf(a.dataSource, newest.id)).toBe(PaymentStatus.COMPLETED)
    expect((await subscription()).lastPaymentId).toBe(newest.id)
  })

  it('T5 applies a purchase whose newer rival was debited and has been credited back', async () => {
    // R15: red if a credited rival still counts as debited: the purchase would lose to nobody.
    const older = await external(PLAN_A, '30 minutes')
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    // R17: A close that fails after the debit cannot be provoked on demand.
    const close = jest
      .spyOn(a.checkout as any, 'closeWalletPayment')
      .mockRejectedValue(new Error('Close crash'))
    await a.checkout
      .processCheckout(planCheckout(BRAND_ID, wallet.id, 'credited-rival', PLAN_B))
      .catch(() => undefined)
    const rival = await findPaymentByKey(a.dataSource, 'credited-rival')
    await sweepAfter(a, rival.id, 2 * 60 * 60 * 1000)
    close.mockRestore()
    expect(await statusOf(a.dataSource, rival.id)).toBe(PaymentStatus.REFUNDED)

    await confirm(older.id)

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(older.id)).toHaveLength(0)
    const sub = await subscription()
    expect(sub.planSlug).toBe(PLAN_A)
    expect(sub.lastPaymentId).toBe(older.id)
  })
})
