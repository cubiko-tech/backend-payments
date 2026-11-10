// R6: one responsibility, the sweep's outcome per scenario; each case provokes its own interleaving.
import { In } from 'typeorm'

import { lockBrandPlan } from '../src/checkout/wallet-payment-close'
import {
  SubscriptionProvider,
  SubscriptionStatus,
} from '../src/subscription/entities/subscription.entity'
import {
  PLAN_APPLYING_EVENTS,
  SubscriptionEvent,
  SubscriptionEventType,
} from '../src/subscription/entities/subscriptionEvent.entity'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { ProviderFactory } from '../src/provider/provider.factory'
import { logger } from '../src/shared/logger/logger'
import { Payment } from '../src/payment/entities/payment.entity'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import { paymentRow, settleBrand, subscriptionOf } from './support/external-purchase.fixture'
import { daysLeft, seedSubscription } from './support/plan-lock.fixture'
import {
  ApiProvider,
  configureProviderClients,
  CONFIRMED_BODY,
  eventsOf,
  externalPayment,
  providerDoing,
  realClientAnswering,
  realStripeClient,
  stripeSession,
  sweepBrand,
} from './support/provider-api.fixture'
import {
  balanceOf,
  cleanBrand,
  createGate,
  movements,
  parkFirstCall,
  planCheckout,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7890001-2222-4333-8444-555555555555'
const AGE = '30 minutes'
const WRONG_AMOUNT = 5000
const BALANCE = 100000
const LOCK_WAIT_MARGIN_MS = 60_000
const API_PROVIDERS: { provider: ApiProvider; column: PaymentProvider }[] = [
  { provider: 'mercadopago', column: PaymentProvider.MERCADOPAGO },
  { provider: 'dropi', column: PaymentProvider.DROPI },
  { provider: 'confio', column: PaymentProvider.CONFIO },
]

describe('The sweep of external payments (PostgreSQL, LOC-89)', () => {
  let a: RaceInstance
  let b: RaceInstance

  beforeAll(async () => {
    configureProviderClients()
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

  const seed = (column: PaymentProvider, overrides: Partial<Payment> = {}) =>
    externalPayment(a.dataSource, BRAND_ID, column, AGE, overrides)
  const stripeConfirms = (instance: RaceInstance, amount = PLAN_PRICE) =>
    realStripeClient(instance, async () => stripeSession(amount))
  const countLog = (completed: number) =>
    expect.stringContaining(`1 checked, ${completed} completed`)

  const expectCompletedOnce = async (paymentId: string) => {
    expect(await statusOf(a.dataSource, paymentId)).toBe(PaymentStatus.COMPLETED)
    expect(daysLeft((await subscriptionOf(a.dataSource, BRAND_ID))!)).toBe(30)
    expect(await eventsOf(a.dataSource, paymentId)).toBe(1)
  }

  const expectRejectedForAmount = async (paymentId: string) => {
    const row = await paymentRow(a.dataSource, paymentId)
    expect(row.status).toBe(PaymentStatus.FAILED)
    expect(row.metadata.amountMismatch).toEqual(
      expect.objectContaining({ code: 'PROVIDER_AMOUNT_MISMATCH' }),
    )
    expect(await subscriptionOf(a.dataSource, BRAND_ID)).toBeNull()
  }

  /** Plan applied and the close died in the invoice, so the purchase stays `processing`. */
  const appliedWithoutCompleting = async (paymentId: string) => {
    const invoices = a.moduleRef.get(InvoiceService) as any
    // R17: A crash between applying the plan and completing cannot be provoked on demand.
    invoices.create.mockRejectedValueOnce(new Error('Invoice crash'))
    await expect(
      a.checkout.completeExternalPayment(paymentId, { source: 'webhook' }),
    ).rejects.toThrow('Invoice crash')
  }

  it('E1 completes a lost Stripe payment with its days once', async () => {
    // R15: red if the sweep filters only Confio again: the payment stays pending and later fails.
    const payment = await seed(PaymentProvider.STRIPE)
    stripeConfirms(a)

    await sweepBrand(a, BRAND_ID)

    await expectCompletedOnce(payment.id)
  })

  it.each(API_PROVIDERS)(
    'E2 completes a lost $provider payment through its real client',
    async ({ provider, column }) => {
      // R15: red if the Mercado Pago client asks /v1/payments/<id>: its row keeps a preference id.
      const payment = await seed(column)
      realClientAnswering(a, provider, CONFIRMED_BODY[provider](PLAN_PRICE))

      await sweepBrand(a, BRAND_ID)

      await expectCompletedOnce(payment.id)
    },
  )

  it(
    'E3 finishes a confirmed payment that timed out on the plan lock, without counting the failure',
    async () => {
      // R15: red if the sweep stops selecting processing: the second pass never sees the payment.
      const payment = await seed(PaymentProvider.STRIPE)
      stripeConfirms(a)
      const log = jest.spyOn(logger, 'log')
      const holder = a.dataSource.createQueryRunner()
      await holder.connect()
      await holder.startTransaction()
      try {
        await lockBrandPlan(holder, BRAND_ID)
        await sweepBrand(a, BRAND_ID)
      } finally {
        await holder.rollbackTransaction()
        await holder.release()
      }

      expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PROCESSING)
      expect(await subscriptionOf(a.dataSource, BRAND_ID)).toBeNull()
      expect(log).toHaveBeenCalledWith('info', countLog(0))

      await sweepBrand(a, BRAND_ID)

      await expectCompletedOnce(payment.id)
      expect(log).toHaveBeenCalledWith('info', countLog(1))
    },
    LOCK_WAIT_MARGIN_MS,
  )

  it('E8 does not apply a Stripe payment confirmed for another amount, and stays out', async () => {
    // R15: red if the sweep stops passing providerStatus: the plan is applied for the wrong amount.
    const payment = await seed(PaymentProvider.STRIPE)
    stripeConfirms(a, WRONG_AMOUNT)

    await sweepBrand(a, BRAND_ID)
    await expectRejectedForAmount(payment.id)

    expect(await a.checkout.completeExternalPayment(payment.id, { source: 'retry' })).toBe(false)
    await expectRejectedForAmount(payment.id)
  })

  it.each(API_PROVIDERS)(
    'E8 does not apply a $provider payment confirmed for another amount',
    async ({ provider, column }) => {
      // R15: red if this client drops the amount from its status answer: nothing to compare.
      const payment = await seed(column)
      realClientAnswering(a, provider, CONFIRMED_BODY[provider](WRONG_AMOUNT))

      await sweepBrand(a, BRAND_ID)

      await expectRejectedForAmount(payment.id)
    },
  )

  it('E8 does not credit a processing recharge confirmed for another amount', async () => {
    // R15: red if the sweep stops passing providerStatus: the wallet gets the full recharge.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await seed(PaymentProvider.STRIPE, {
      purpose: PaymentPurpose.WALLET_RECHARGE,
      purposeId: null,
      walletId: wallet.id,
      status: PaymentStatus.PROCESSING,
    })
    stripeConfirms(a, WRONG_AMOUNT)

    await sweepBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('E9 completes a payment whose provider does not report the amount', async () => {
    // R15: red if a missing amount counts as a mismatch: every such confirmation would fail.
    const payment = await seed(PaymentProvider.CONFIO)
    realClientAnswering(a, 'confio', CONFIRMED_BODY.confio())

    await sweepBrand(a, BRAND_ID)

    await expectCompletedOnce(payment.id)
  })

  it('E10 does not count a payment another call of this instance is closing', async () => {
    // R15: red if the sweep counts without looking at what completeExternalPayment returned.
    const payment = await seed(PaymentProvider.STRIPE)
    stripeConfirms(a)
    ;(a.checkout as any).inFlightCompletions.add(payment.id)
    const log = jest.spyOn(logger, 'log')

    try {
      await sweepBrand(a, BRAND_ID)
    } finally {
      ;(a.checkout as any).inFlightCompletions.delete(payment.id)
    }

    expect(log).toHaveBeenCalledWith('info', countLog(0))
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PENDING)
  })

  it('E10 does not count a purchase that lost to a newer one', async () => {
    // R15: red if the sweep counts without looking at what completeExternalPayment returned.
    const payment = await seed(PaymentProvider.STRIPE)
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await a.checkout.processCheckout(
      planCheckout(BRAND_ID, wallet.id, 'loc89-newer', 'dropi-roax-plus'),
    )
    stripeConfirms(a)
    const log = jest.spyOn(logger, 'log')

    await sweepBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(log).toHaveBeenCalledWith('info', countLog(0))
  })

  it.each([PaymentStatus.PENDING, PaymentStatus.PROCESSING])(
    'E11 applies the days and tells it once with two instances sweeping a %s payment',
    async (status) => {
      // R15: red if the close ignores that another instance completed: two publications.
      const payment = await seed(PaymentProvider.STRIPE, { status })
      stripeConfirms(a)
      stripeConfirms(b)
      const published = [a, b].map(
        (instance) => instance.moduleRef.get(EventBusService).publishPaymentCompleted as jest.Mock,
      )
      published.forEach((publish) => publish.mockClear())
      const gate = createGate()
      parkFirstCall(a.checkout, 'assignCurrentPlanInRoles', gate)

      const first = sweepBrand(a, BRAND_ID)
      await gate.reached
      await sweepBrand(b, BRAND_ID)
      gate.release()
      await first

      await expectCompletedOnce(payment.id)
      expect(published[0].mock.calls.length + published[1].mock.calls.length).toBe(1)
    },
  )

  it('E11 credits a recharge once with two instances sweeping it', async () => {
    // R15: red if the credit loses its idempotency key: the second instance credits it again.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await seed(PaymentProvider.STRIPE, {
      purpose: PaymentPurpose.WALLET_RECHARGE,
      purposeId: null,
      walletId: wallet.id,
    })
    stripeConfirms(a)
    stripeConfirms(b)
    const gate = createGate()
    parkFirstCall(a.wallet, 'credit', gate)

    const first = sweepBrand(a, BRAND_ID)
    await gate.reached
    await sweepBrand(b, BRAND_ID)
    gate.release()
    await first

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await movements(a.dataSource, payment.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE + PLAN_PRICE)
  })

  it('E13 completes a payment that expired after the sweep read it', async () => {
    // R15: red if completeExternalPayment refuses failed rows: a paid payment stays failed.
    const payment = await seed(PaymentProvider.STRIPE)
    providerDoing(a, async () => {
      await a.dataSource
        .getRepository(Payment)
        .update({ id: payment.id }, { status: PaymentStatus.FAILED })
      return { status: 'completed' }
    })

    await sweepBrand(a, BRAND_ID)

    await expectCompletedOnce(payment.id)
  })

  it(
    'E14 leaves a payment that timed out completing, with its plan applied, to the settling sweep',
    async () => {
      // R15: red if settleLostExternalPayments stops selecting a processing row with its event.
      const payment = await seed(PaymentProvider.STRIPE)
      const gate = createGate()
      const invoices = a.moduleRef.get(InvoiceService) as any
      // R17: Between applying the plan and completing is the only place this timeout can land.
      invoices.create.mockImplementationOnce(async () => {
        gate.arrive()
        await gate.wait
        return { data: { id: 'inv-e14', invoiceNumber: 'CK-E14' } }
      })
      const holder = a.dataSource.createQueryRunner()
      await holder.connect()
      await holder.startTransaction()
      try {
        const confirming = a.checkout.completeExternalPayment(payment.id, { source: 'webhook' })
        await gate.reached
        await lockBrandPlan(holder, BRAND_ID)
        gate.release()
        await expect(confirming).rejects.toThrow('lock timeout')
      } finally {
        await holder.rollbackTransaction()
        await holder.release()
      }
      expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PROCESSING)
      const asked = (a.moduleRef.get(ProviderFactory) as any).getProvider as jest.Mock
      asked.mockClear()

      await settleBrand(a, BRAND_ID)

      await expectCompletedOnce(payment.id)
      expect(asked).not.toHaveBeenCalled()
    },
    LOCK_WAIT_MARGIN_MS,
  )

  it('E15 finishes a purchase whose plan was applied before another amount came in', async () => {
    // R15: red if the mismatch ignores what was given: failed, with its days and no way back.
    const payment = await seed(PaymentProvider.STRIPE)
    await appliedWithoutCompleting(payment.id)
    stripeConfirms(a, WRONG_AMOUNT)

    await sweepBrand(a, BRAND_ID)

    await expectCompletedOnce(payment.id)
    expect((await paymentRow(a.dataSource, payment.id)).metadata.amountMismatch).toBeUndefined()
  })

  it('E18 does not renew a past-due plan whose payment link was paid with another amount', async () => {
    // R15: red if any event counts as an effect: the event of the link hides the mismatch.
    const sub = await seedSubscription(a.dataSource, BRAND_ID, {
      status: SubscriptionStatus.PAST_DUE,
      provider: SubscriptionProvider.STRIPE,
    })
    const payment = await seed(PaymentProvider.STRIPE)
    const events = a.dataSource.getRepository(SubscriptionEvent)
    await events.save(
      events.create({
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.PAYMENT_FAILED,
        triggeredBy: 'system',
        paymentId: payment.id,
      }),
    )
    const invoices = a.moduleRef.get(InvoiceService).create as jest.Mock
    invoices.mockClear()
    stripeConfirms(a, WRONG_AMOUNT)

    await sweepBrand(a, BRAND_ID)

    const row = await paymentRow(a.dataSource, payment.id)
    expect(row.status).toBe(PaymentStatus.FAILED)
    expect(row.metadata.amountMismatch).toBeDefined()
    const after = (await subscriptionOf(a.dataSource, BRAND_ID))!
    expect(after.status).toBe(SubscriptionStatus.PAST_DUE)
    expect(after.currentPeriodEnd).toEqual(sub.currentPeriodEnd)
    expect(
      await events.countBy({ paymentId: payment.id, eventType: In(PLAN_APPLYING_EVENTS) }),
    ).toBe(0)
    expect(invoices).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'no payments', results: [] },
    { name: 'only rejected payments', results: [{ status: 'rejected' }] },
  ])('E17 completes nothing when Mercado Pago finds $name', async ({ results }) => {
    // R15: red if a search with nothing approved reads as completed: a plan with no money.
    const payment = await seed(PaymentProvider.MERCADOPAGO)
    realClientAnswering(a, 'mercadopago', { results })

    await sweepBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PENDING)
    expect(await subscriptionOf(a.dataSource, BRAND_ID)).toBeNull()
  })

  it('completes nothing when a Stripe checkout session is complete but payment_status is unpaid', async () => {
    // R15: red if StripeProvider.getPaymentStatus maps complete + unpaid to completed.
    const payment = await seed(PaymentProvider.STRIPE)
    realStripeClient(a, async () => stripeSession(PLAN_PRICE, 'unpaid'))

    await sweepBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PENDING)
    expect(await subscriptionOf(a.dataSource, BRAND_ID)).toBeNull()
  })
})
