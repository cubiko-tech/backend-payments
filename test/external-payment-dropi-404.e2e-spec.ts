import { HttpStatus } from '@nestjs/common'

import { buildIdempotencyFingerprint } from '../src/checkout/checkout-idempotency'
import { CheckoutRequest } from '../src/checkout/checkout.service'
import { Payment, PaymentProvider, PaymentStatus } from '../src/payment/entities/payment.entity'
import { logger } from '../src/shared/logger/logger'
import { WebhookEvent, WebhookStatus } from '../src/webhook/entities/webhookEvent.entity'
import { WebhookService } from '../src/webhook/webhook.service'
import { subscriptionOf } from './support/external-purchase.fixture'
import {
  configureProviderClients,
  CONFIRMED_BODY,
  expireBrand,
  externalPayment,
  realClientAnswering,
  sweepBrand,
} from './support/provider-api.fixture'
import {
  cleanBrand,
  PLAN_PRICE,
  RaceInstance,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7890102-2222-4333-8444-555555555102'
const PAST_EXPIRY = '25 hours'
const EVENT_PREFIX = 'loc102-'
const NOT_FOUND = { message: 'not found' }

describe('A Dropi 404 is no answer about the payment (PostgreSQL, LOC-102)', () => {
  let a: RaceInstance
  let b: RaceInstance

  const clean = async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await a.dataSource
      .getRepository(WebhookEvent)
      .query(`DELETE FROM webhook_events WHERE "providerEventId" LIKE '${EVENT_PREFIX}%'`)
  }

  beforeAll(async () => {
    configureProviderClients()
    a = await startInstance()
    b = await startInstance()
  })

  beforeEach(clean)

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await clean()
    await stopInstance(a)
    await stopInstance(b)
  })

  const seed = (overrides: Partial<Payment> = {}) =>
    externalPayment(a.dataSource, BRAND_ID, PaymentProvider.DROPI, PAST_EXPIRY, overrides)
  const dropiAnswers404 = (instance: RaceInstance = a) =>
    realClientAnswering(instance, 'dropi', NOT_FOUND, 404)
  const expectStatus = async (paymentId: string, status: PaymentStatus) =>
    expect(await statusOf(a.dataSource, paymentId)).toBe(status)

  /** How many error logs named this payment's charge. */
  const errorLogsOf = (log: jest.SpyInstance, payment: Payment) =>
    log.mock.calls.filter(
      ([level, message]) =>
        level === 'error' && String(message).includes(String(payment.providerPaymentId)),
    ).length

  /** Delivers a Dropi charge notification through the real webhook, and waits for its outcome. */
  const deliverChargeCompleted = async (payment: Payment) => {
    const events = a.dataSource.getRepository(WebhookEvent)
    const webhook = new WebhookService(
      events,
      events,
      a.dataSource.getRepository(Payment),
      // R17: The retry queue needs Redis and only acts on a failure, which fails the case below.
      { add: jest.fn() } as any,
      {} as any,
    )
    webhook.setCheckoutService(a.checkout)
    const providerEventId = `${EVENT_PREFIX}${payment.id}`

    await webhook.receive('dropi', 'charge.completed', providerEventId, {
      chargeId: payment.providerPaymentId,
    })

    const deadline = Date.now() + 5000
    let event = await events.findOneByOrFail({ providerEventId })
    while (event.status !== WebhookStatus.PROCESSED && Date.now() < deadline) {
      if (event.status === WebhookStatus.FAILED) break
      await new Promise((resolve) => setTimeout(resolve, 50))
      event = await events.findOneByOrFail({ providerEventId })
    }
    expect(event.status).toBe(WebhookStatus.PROCESSED)
  }

  /** A purchase stored as `processCheckout` leaves it, so a retry with its key takes the real path. */
  const seedWithKey = async (key: string) => {
    const req: CheckoutRequest = {
      brandId: BRAND_ID,
      userId: 'user-loc101',
      purpose: 'plan_purchase',
      provider: 'dropi',
      planSlug: 'dropi-roax',
      idempotencyKey: key,
    }
    const payment = await seed({ idempotencyKey: key })
    const checkoutResult = { paymentId: payment.id, status: 'pending', checkoutUrl: null }
    await a.dataSource.getRepository(Payment).update(payment.id, {
      metadata: {
        ...payment.metadata,
        idempotencyFingerprint: buildIdempotencyFingerprint(req),
        checkoutResult,
      },
    })
    return { payment, req, checkoutResult }
  }

  it('E1 keeps the payment pending and logs an error on every expiry pass', async () => {
    // R15: red if the 404 counts as a missing payment again: it ends failed at 24 hours.
    const payment = await seed()
    dropiAnswers404()
    const log = jest.spyOn(logger, 'log')

    await expireBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.PENDING)
    expect(errorLogsOf(log, payment)).toBe(1)

    await expireBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.PENDING)
    expect(errorLogsOf(log, payment)).toBe(2)
  })

  it('E2 completes a paid payment once the route answers, after expiry and sweep got a 404', async () => {
    // R15: red if the 404 counts as a missing payment again: the expiry fails it first.
    const payment = await seed()
    dropiAnswers404()
    const log = jest.spyOn(logger, 'log')

    await expireBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.PENDING)
    await sweepBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.PENDING)
    expect(errorLogsOf(log, payment)).toBe(2)
    expect(await subscriptionOf(a.dataSource, BRAND_ID)).toBeNull()

    realClientAnswering(a, 'dropi', CONFIRMED_BODY.dropi(PLAN_PRICE))
    await sweepBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.COMPLETED)
  })

  it('E3 expires nothing with two instances passing at once, each logging its error', async () => {
    // R15: red if the 404 counts as a missing payment again: either instance fails the row.
    const payment = await seed()
    dropiAnswers404(a)
    dropiAnswers404(b)
    const log = jest.spyOn(logger, 'log')

    await Promise.all([expireBrand(a, BRAND_ID), expireBrand(b, BRAND_ID)])

    await expectStatus(payment.id, PaymentStatus.PENDING)
    expect(errorLogsOf(log, payment)).toBe(2)
  })

  it('E4 completes through the Dropi webhook after a 404 pass, and expiry leaves it', async () => {
    // R15: red if the 404 counts as a missing payment again: the first pass fails it.
    const payment = await seed()
    dropiAnswers404()

    await expireBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.PENDING)

    await deliverChargeCompleted(payment)
    await expectStatus(payment.id, PaymentStatus.COMPLETED)

    await expireBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.COMPLETED)
  })

  it('E5 answers a retry with the same key with the stored pending while the 404 lasts', async () => {
    // R15: red if the 404 counts as a missing payment again: the retry finds a failed payment.
    const { payment, req, checkoutResult } = await seedWithKey('loc102-retry-pending')
    dropiAnswers404()

    await expireBrand(a, BRAND_ID)

    await expect(a.checkout.processCheckout(req)).resolves.toEqual(checkoutResult)
    await expectStatus(payment.id, PaymentStatus.PENDING)
  })

  it('E5 lets the user cancel while the 404 lasts, and a retry past the window is rejected', async () => {
    // R15: red if the 404 counts as a missing payment again: the row is failed, nothing to cancel.
    const { payment, req } = await seedWithKey('loc102-retry-cancelled')
    dropiAnswers404()

    await expireBrand(a, BRAND_ID)
    await a.payments.cancelPayment(payment.id)
    await expectStatus(payment.id, PaymentStatus.FAILED)

    await expireBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.FAILED)
    await expect(a.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'IDEMPOTENT_RETRY_EXPIRED',
      status: HttpStatus.CONFLICT,
    })
  })

  it('E6 expires a payment Dropi answers as still pending', async () => {
    // R15: red if providerLetsExpire stops expiring on an answer: abandoned charges never leave.
    const payment = await seed()
    realClientAnswering(a, 'dropi', { status: 'pending' })

    await expireBrand(a, BRAND_ID)

    await expectStatus(payment.id, PaymentStatus.FAILED)
  })

  it('E7 expires a payment without a charge, without asking Dropi', async () => {
    // R15: red if a payment without providerPaymentId is asked about: the 404 keeps it pending.
    const payment = await seed({ providerPaymentId: null as unknown as string })
    dropiAnswers404()

    await expireBrand(a, BRAND_ID)

    await expectStatus(payment.id, PaymentStatus.FAILED)
    expect(global.fetch).not.toHaveBeenCalled()
  })
})
