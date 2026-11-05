// R6: Single-responsibility e2e suite for webhook auth, deduplication, and provider/amount scoping.
import { createHash, createHmac } from 'crypto'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'
import { Repository } from 'typeorm'

import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { ConfioProvider } from '../src/provider/confio/confio.provider'
import { DropiProvider } from '../src/provider/dropi/dropi.provider'
import { MercadoPagoProvider } from '../src/provider/mercadopago/mercadopago.provider'
import { StripeProvider } from '../src/provider/stripe/stripe.provider'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { WebhookEvent, WebhookStatus } from '../src/webhook/entities/webhookEvent.entity'
import { WebhookController } from '../src/webhook/webhook.controller'
import { WebhookService } from '../src/webhook/webhook.service'
import { seedExternalPurchase, subscriptionOf } from './support/external-purchase.fixture'
import {
  balanceOf,
  cleanBrand,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'b1180118-2222-4333-8444-555555555118'
const MP_SECRET = 'loc118-mp-webhook-secret'
const DROPI_SECRET = 'loc118-dropi-webhook-secret'
const CONFIO_WEBHOOK_SECRET = 'loc117-confio-webhook-key'
const CONFIO_TOKEN = 'loc117-confio-access-token'
const MARKER_PREFIX = 'loc118-'

function signConfio(
  data: Record<string, unknown>,
  properties: string[],
  timestamp: number,
): string {
  const concatenated =
    properties.map((p) => String(data[p])).join('') + String(timestamp) + CONFIO_WEBHOOK_SECRET
  return createHash('sha256').update(concatenated).digest('hex').toUpperCase()
}

function signMp(dataId: string, ts: number): string {
  const manifest = `id:${dataId};request-id:;ts:${ts};`
  return `ts=${ts},v1=${createHmac('sha256', MP_SECRET).update(manifest).digest('hex')}`
}

function signDropi(rawBody: string): string {
  return createHmac('sha256', DROPI_SECRET).update(Buffer.from(rawBody, 'utf8')).digest('hex')
}

function mockMpPaymentGet(body: unknown, status = 200): jest.SpyInstance {
  // R17: External paid API; exercises the real MercadoPagoProvider HTTP path up to global.fetch.
  return jest.spyOn(global, 'fetch').mockImplementation(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

describe('Dropi and Mercado Pago webhook deduplication and status check (PostgreSQL, LOC-118)', () => {
  let a: RaceInstance
  let app: INestApplication
  let events: Repository<WebhookEvent>
  let webhook: WebhookService
  const originalEnv = process.env

  const clean = async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await events.query(
      `DELETE FROM webhook_events
       WHERE "providerEventId" LIKE $1
          OR payload ->> 'marker' LIKE $1
          OR payload -> 'data' ->> 'id' LIKE $1`,
      [`%${MARKER_PREFIX}%`],
    )
  }

  const waitEventSettled = async (provider: string, providerEventId: string) => {
    const deadline = Date.now() + 5000
    let row = await events.findOneBy({ provider, providerEventId })
    while (
      row &&
      (row.status === WebhookStatus.RECEIVED || row.status === WebhookStatus.PROCESSING) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 40))
      row = await events.findOneBy({ provider, providerEventId })
    }
    return row
  }

  const deliverDropi = (body: Record<string, unknown>) => {
    const raw = JSON.stringify(body)
    return request(app.getHttpServer())
      .post('/webhook/dropi')
      .set('content-type', 'application/json')
      .set('x-dropi-signature', signDropi(raw))
      .send(raw)
  }

  const deliverMpCreated = (mpPaymentId: string, ts: number) =>
    request(app.getHttpServer())
      .post('/webhook/mercadopago')
      .set('content-type', 'application/json')
      .set('x-signature', signMp(mpPaymentId, ts))
      .send(
        JSON.stringify({ type: 'payment', action: 'payment.created', data: { id: mpPaymentId } }),
      )

  const dropiRowsByMarker = (marker: string) =>
    events
      .createQueryBuilder('e')
      .where("e.provider = 'dropi'")
      .andWhere(`e.payload ->> 'marker' = :marker`, { marker })
      .getMany()

  beforeAll(async () => {
    process.env = {
      ...originalEnv,
      MP_WEBHOOK_SECRET: MP_SECRET,
      MP_ACCESS_TOKEN: 'APP_USR-loc118-test-token',
      DROPI_WEBHOOK_SECRET: DROPI_SECRET,
      CONFIO_WEBHOOK_KEY: CONFIO_WEBHOOK_SECRET,
      CONFIO_ACCESS_TOKEN: CONFIO_TOKEN,
      CONFIO_STORE_ID: 'store-loc117',
    }
    a = await startInstance()
    events = a.dataSource.getRepository(WebhookEvent)
    const mpProvider = new MercadoPagoProvider()
    const dropiProvider = new DropiProvider()
    const confioProvider = new ConfioProvider()

    webhook = new WebhookService(
      events,
      events,
      a.dataSource.getRepository(Payment),
      // R17: BullMQ queue requires Redis; e2e asserts DB payment/event state, not queue calls.
      { add: jest.fn().mockResolvedValue(undefined) } as any,
      // R17: Confio subscription route is not under test in this spec.
      { handle: jest.fn() } as any,
      mpProvider,
    )
    webhook.setCheckoutService(a.checkout)

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: MercadoPagoProvider, useValue: mpProvider },
        { provide: DropiProvider, useValue: dropiProvider },
        { provide: WebhookService, useValue: webhook },
        // R17: Stripe SDK constructEvent is not exercised in this spec.
        { provide: StripeProvider, useValue: {} },
        { provide: ConfioProvider, useValue: confioProvider },
      ],
    })
      // R17: Only admin routes use ApiAuthGuard; provider webhook endpoints are public with HMAC.
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication({ rawBody: true })
    await app.init()
  })

  beforeEach(async () => {
    await clean()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      if (events) await clean()
    } finally {
      try {
        if (app) await app.close()
      } finally {
        await stopInstance(a)
        process.env = originalEnv
      }
    }
  })

  it('E1 deduplicates 3 deliveries of the same Dropi notice without eventId into 1 row', async () => {
    // R15: red if Dropi falls back to dropi_${Date.now()}: 3 deliveries create 3 rows.
    const marker = `${MARKER_PREFIX}e1`
    const body = { marker, event: 'charge.failed', chargeId: `${MARKER_PREFIX}ch-e1` }
    const expectedId = `dropi:sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`

    const first = await deliverDropi(body)
    await new Promise((r) => setTimeout(r, 5))
    const second = await deliverDropi(body)
    await new Promise((r) => setTimeout(r, 5))
    const third = await deliverDropi(body)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(200)

    await waitEventSettled('dropi', expectedId)
    const rows = await dropiRowsByMarker(marker)

    expect(rows).toHaveLength(1)
    expect(rows[0].providerEventId).toBe(expectedId)
    expect(second.body.duplicate).toBe(true)
    expect(third.body.duplicate).toBe(true)
  })

  it('E2 deduplicates a second Dropi delivery without eventId via UQ_webhook_events_provider_event and returns the dropi winner', async () => {
    // R15: red if 23505 is not caught (returns error instead of duplicate) or winner lookup omits provider (returns stripe row).
    const marker = `${MARKER_PREFIX}e2`
    const body = { marker, event: 'charge.failed', chargeId: `${MARKER_PREFIX}ch-e2` }
    const expectedId = `dropi:sha256:${createHash('sha256').update(JSON.stringify(body)).digest('hex')}`

    await webhook.receive('stripe', 'unknown.event', expectedId, { marker: `${marker}-stripe` })
    await waitEventSettled('stripe', expectedId)

    const first = await deliverDropi(body)
    expect(first.status).toBe(200)
    await waitEventSettled('dropi', expectedId)

    // R17: Forces the second delivery past the pre-check SELECT so its INSERT collides with UQ_webhook_events_provider_event (23505).
    jest.spyOn(events, 'findOne').mockResolvedValueOnce(null)
    const second = await deliverDropi(body)

    expect(second.status).toBe(200)
    expect(second.body.error).toBeUndefined()
    expect(second.body.duplicate).toBe(true)
    expect(second.body.data.provider).toBe('dropi')
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(await dropiRowsByMarker(marker)).toHaveLength(1)
  })

  it('E3 keeps payment pending and does not credit wallet when Mercado Pago payment.created has status pending', async () => {
    // R15: red if Mercado Pago completes without checking status or ignores pending: credits 10000 and marks completed.
    const mpPaymentId = `${MARKER_PREFIX}mp-pending-3`
    const ts = Math.floor(Date.now() / 1000)
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    const paymentRepo = a.dataSource.getRepository(Payment)
    const payment = await paymentRepo.save(
      paymentRepo.create({
        brandId: BRAND_ID,
        userId: 'user-loc118',
        walletId: wallet.id,
        provider: PaymentProvider.MERCADOPAGO,
        // Seeded equal to mpPaymentId so reverting to the pre-LOC-118 lookup also finds and credits it.
        providerPaymentId: mpPaymentId,
        purpose: PaymentPurpose.WALLET_RECHARGE,
        amount: 10000,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        metadata: { country: 'CO', taxRate: 0.19, taxName: 'IVA' },
      }),
    )

    mockMpPaymentGet({
      id: mpPaymentId,
      status: 'pending',
      external_reference: payment.id,
      transaction_amount: 10000,
    })

    const res = await deliverMpCreated(mpPaymentId, ts)

    expect(res.status).toBe(200)
    const event = await waitEventSettled('mercadopago', `mp:payment.created:${mpPaymentId}:${ts}`)
    expect(event?.status).toBe(WebhookStatus.PROCESSED)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(0)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PENDING)
  })

  it('E4 stores two rows when two different providers receive the same providerEventId', async () => {
    // R15: red if receive() or the DB index deduplicates on providerEventId alone without provider.
    const sharedEventId = `${MARKER_PREFIX}shared-evt-4`

    const dropiRes = await webhook.receive('dropi', 'charge.failed', sharedEventId, {
      marker: `${MARKER_PREFIX}e4-dropi`,
      chargeId: 'ch-none',
    })
    const stripeRes = await webhook.receive('stripe', 'unknown.event', sharedEventId, {
      marker: `${MARKER_PREFIX}e4-stripe`,
    })

    expect((dropiRes as any).duplicate).toBeUndefined()
    expect((stripeRes as any).duplicate).toBeUndefined()

    await waitEventSettled('dropi', sharedEventId)
    await waitEventSettled('stripe', sharedEventId)

    const rows = await events.findBy({ providerEventId: sharedEventId })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.provider).sort()).toEqual(['dropi', 'stripe'])
  })

  it('E5 completes a Mercado Pago payment when payment.created resolves status approved and matching external_reference', async () => {
    // R15: red if approved notices are ignored or external_reference lookup fails: payment stays pending.
    const mpPaymentId = `${MARKER_PREFIX}mp-approved-5`
    const ts = Math.floor(Date.now() / 1000)
    const payment = await seedExternalPurchase(a.dataSource, BRAND_ID, 'pro', {
      overrides: { provider: PaymentProvider.MERCADOPAGO, providerPaymentId: 'pref_loc118_5' },
    })

    mockMpPaymentGet({
      id: mpPaymentId,
      status: 'approved',
      external_reference: payment.id,
      transaction_amount: PLAN_PRICE,
    })

    const res = await deliverMpCreated(mpPaymentId, ts)

    expect(res.status).toBe(200)
    const event = await waitEventSettled('mercadopago', `mp:payment.created:${mpPaymentId}:${ts}`)
    expect(event?.status).toBe(WebhookStatus.PROCESSED)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect((await subscriptionOf(a.dataSource, BRAND_ID))?.planSlug).toBe('pro')
  })

  it('E6 does not complete or grant a subscription twice when an approved notice arrives again with a new ts', async () => {
    // R15: red if a second approved notice re-completes an already completed payment.
    const mpPaymentId = `${MARKER_PREFIX}mp-retry-6`
    const ts1 = Math.floor(Date.now() / 1000) - 10
    const ts2 = ts1 + 5
    const payment = await seedExternalPurchase(a.dataSource, BRAND_ID, 'pro', {
      overrides: { provider: PaymentProvider.MERCADOPAGO, providerPaymentId: 'pref_loc118_6' },
    })

    mockMpPaymentGet({
      id: mpPaymentId,
      status: 'approved',
      external_reference: payment.id,
      transaction_amount: PLAN_PRICE,
    })

    await deliverMpCreated(mpPaymentId, ts1)
    await waitEventSettled('mercadopago', `mp:payment.created:${mpPaymentId}:${ts1}`)

    const second = await deliverMpCreated(mpPaymentId, ts2)
    const secondEvent = await waitEventSettled(
      'mercadopago',
      `mp:payment.created:${mpPaymentId}:${ts2}`,
    )

    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBeUndefined()
    expect(secondEvent?.status).toBe(WebhookStatus.PROCESSED)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    const sub = await subscriptionOf(a.dataSource, BRAND_ID)
    const subEvents = await a.dataSource
      .getRepository(SubscriptionEvent)
      .countBy({ subscriptionId: sub!.id })
    expect(subEvents).toBe(1)
  })

  it('E7 leaves a payment of another provider untouched when Mercado Pago external_reference points to it', async () => {
    // R15: red if resolveMercadoPagoNotice skips the payment.provider === MERCADOPAGO check.
    const mpPaymentId = `${MARKER_PREFIX}mp-cross-7`
    const ts = Math.floor(Date.now() / 1000)
    const dropiPayment = await seedExternalPurchase(a.dataSource, BRAND_ID, 'pro', {
      overrides: { provider: PaymentProvider.DROPI, providerPaymentId: 'ch_dropi_loc118_7' },
    })

    mockMpPaymentGet({
      id: mpPaymentId,
      status: 'approved',
      external_reference: dropiPayment.id,
      transaction_amount: PLAN_PRICE,
    })

    const res = await deliverMpCreated(mpPaymentId, ts)

    expect(res.status).toBe(200)
    const event = await waitEventSettled('mercadopago', `mp:payment.created:${mpPaymentId}:${ts}`)
    expect(event?.status).toBe(WebhookStatus.PROCESSED)
    expect(await statusOf(a.dataSource, dropiPayment.id)).toBe(PaymentStatus.PENDING)
  })

  it('marks the webhook event failed and leaves the payment pending when Mercado Pago GET fails', async () => {
    // R15: red if a Mercado Pago outage is swallowed as PROCESSED instead of marking the event FAILED.
    const mpPaymentId = `${MARKER_PREFIX}mp-down-8`
    const ts = Math.floor(Date.now() / 1000)
    const payment = await seedExternalPurchase(a.dataSource, BRAND_ID, 'pro', {
      overrides: { provider: PaymentProvider.MERCADOPAGO, providerPaymentId: 'pref_loc118_8' },
    })

    mockMpPaymentGet('<html>Bad gateway</html>', 502)

    const res = await deliverMpCreated(mpPaymentId, ts)

    expect(res.status).toBe(200)
    const event = await waitEventSettled('mercadopago', `mp:payment.created:${mpPaymentId}:${ts}`)
    expect(event?.status).toBe(WebhookStatus.FAILED)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PENDING)
  })

  it('E8 rejects a Confio signed webhook outside the 24h timestamp window with 401 and deduplicates unsigned field mutations within the window', async () => {
    // R15: red if verifyConfioWebhookSignature omits the 24h window or eventId reads unsigned fields.
    const subName = `stores/s/subscription-plans/p/subscriptions/${MARKER_PREFIX}sub-e8`
    const nowSec = Math.floor(Date.now() / 1000)
    const expiredTs = nowSec - 24 * 60 * 60 - 60
    const expiredData = {
      name: subName,
      status: 'PAST_DUE',
      createTime: '2026-01-01T10:00:00Z',
      updateTime: '2026-02-14T10:00:00Z',
    }
    const expiredProps = ['name', 'status']
    const expiredBody = {
      event: 'subscription.subscriptionStatusChanged',
      data: expiredData,
      timestamp: expiredTs,
      signature: {
        properties: expiredProps,
        checksum: signConfio(expiredData, expiredProps, expiredTs),
      },
    }

    const expiredRes = await request(app.getHttpServer())
      .post('/webhook/confio')
      .set('content-type', 'application/json')
      .set('authorization', `Bearer ${CONFIO_WEBHOOK_SECRET}`)
      .send(JSON.stringify(expiredBody))

    expect(expiredRes.status).toBe(401)

    const validData1 = {
      name: subName,
      status: 'PAST_DUE',
      createTime: '2026-01-01T10:00:00Z',
      updateTime: '2026-02-14T10:00:00Z',
      correlationId: 'corr-1',
    }
    const validData2 = {
      ...validData1,
      updateTime: '2099-12-31T23:59:59Z',
      correlationId: 'corr-2',
    }
    const checksum = signConfio(validData1, expiredProps, nowSec)

    const firstValid = await request(app.getHttpServer())
      .post('/webhook/confio')
      .set('content-type', 'application/json')
      .set('authorization', `Bearer ${CONFIO_WEBHOOK_SECRET}`)
      .send(
        JSON.stringify({
          event: 'subscription.subscriptionStatusChanged',
          data: validData1,
          timestamp: nowSec,
          signature: { properties: expiredProps, checksum },
        }),
      )
    const secondValid = await request(app.getHttpServer())
      .post('/webhook/confio')
      .set('content-type', 'application/json')
      .set('authorization', `Bearer ${CONFIO_WEBHOOK_SECRET}`)
      .send(
        JSON.stringify({
          event: 'subscription.subscriptionStatusChanged',
          data: validData2,
          timestamp: nowSec,
          signature: { properties: expiredProps, checksum },
        }),
      )

    expect(firstValid.status).toBe(200)
    expect(secondValid.status).toBe(200)
    expect(secondValid.body.duplicate).toBe(true)

    const expectedEventId = `${subName}:subscription.subscriptionStatusChanged:PAST_DUE:${nowSec}`
    const storedRows = await events.findBy({ provider: 'confio', providerEventId: expectedEventId })
    expect(storedRows).toHaveLength(1)
  })

  it('E9 leaves a payment of another provider pending and uncredited when Confio or Dropi webhook notices reference it, and leaves a notice without confirmed amount pending', async () => {
    // R15: red if WebhookService/CheckoutService omits provider scoping or completes a notice that omits amount.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    const paymentRepo = a.dataSource.getRepository(Payment)
    const stripePayment = await paymentRepo.save(
      paymentRepo.create({
        brandId: BRAND_ID,
        userId: 'user-loc117',
        walletId: wallet.id,
        provider: PaymentProvider.STRIPE,
        providerPaymentId: `${MARKER_PREFIX}cs_stripe_target`,
        purpose: PaymentPurpose.WALLET_RECHARGE,
        amount: 10000,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        metadata: { country: 'CO', taxRate: 0.19, taxName: 'IVA' },
      }),
    )

    const confioCrossRes = await request(app.getHttpServer())
      .post('/webhook/confio')
      .set('content-type', 'application/json')
      .set('authorization', `Bearer ${CONFIO_TOKEN}`)
      .send(
        JSON.stringify({
          event: 'payment.statusChanged',
          data: {
            name: `${MARKER_PREFIX}cs_stripe_target`,
            status: 'FUNDED',
            correlationId: stripePayment.id,
            amountCents: 1000000,
          },
          timestamp: Math.floor(Date.now() / 1000),
        }),
      )
    expect(confioCrossRes.status).toBe(200)
    await waitEventSettled('confio', `${MARKER_PREFIX}cs_stripe_target:FUNDED`)
    expect(await statusOf(a.dataSource, stripePayment.id)).toBe(PaymentStatus.PENDING)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(0)

    const confioNoAmountPayment = await paymentRepo.save(
      paymentRepo.create({
        brandId: BRAND_ID,
        userId: 'user-loc117',
        walletId: wallet.id,
        provider: PaymentProvider.CONFIO,
        providerPaymentId: `${MARKER_PREFIX}confio-no-amount`,
        purpose: PaymentPurpose.WALLET_RECHARGE,
        amount: 10000,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        metadata: { country: 'CO', taxRate: 0.19, taxName: 'IVA' },
      }),
    )

    const noAmountRes = await request(app.getHttpServer())
      .post('/webhook/confio')
      .set('content-type', 'application/json')
      .set('authorization', `Bearer ${CONFIO_TOKEN}`)
      .send(
        JSON.stringify({
          event: 'payment.statusChanged',
          data: {
            name: `${MARKER_PREFIX}confio-no-amount`,
            status: 'FUNDED',
            correlationId: confioNoAmountPayment.id,
          },
          timestamp: Math.floor(Date.now() / 1000),
        }),
      )
    expect(noAmountRes.status).toBe(200)
    await waitEventSettled('confio', `${MARKER_PREFIX}confio-no-amount:FUNDED`)

    const refreshedNoAmount = await paymentRepo.findOneByOrFail({ id: confioNoAmountPayment.id })
    expect(refreshedNoAmount.status).toBe(PaymentStatus.PENDING)
    expect(refreshedNoAmount.metadata?.amountMismatch).toBeUndefined()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(0)
  })
})
