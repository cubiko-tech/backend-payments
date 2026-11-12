import { createHash } from 'crypto'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'

import { EventBusService } from '../src/event-bus/event-bus.service'
import { Payment } from '../src/payment/entities/payment.entity'
import { ConfioProvider } from '../src/provider/confio/confio.provider'
import { DropiProvider } from '../src/provider/dropi/dropi.provider'
import { MercadoPagoProvider } from '../src/provider/mercadopago/mercadopago.provider'
import { ProviderFactory } from '../src/provider/provider.factory'
import { StripeProvider } from '../src/provider/stripe/stripe.provider'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../src/subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../src/subscription/entities/subscriptionEvent.entity'
import { ConfioSubscriptionWebhookService } from '../src/webhook/confio-subscription-webhook.service'
import { WebhookEvent, WebhookStatus } from '../src/webhook/entities/webhookEvent.entity'
import { WebhookController } from '../src/webhook/webhook.controller'
import { WebhookService } from '../src/webhook/webhook.service'
import { elapseRetryBackoff, seedSubscription, sweepOnlyBrands } from './support/plan-lock.fixture'
import {
  cleanBrand,
  RaceInstance,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'b1630163-2222-4333-8444-555555555163'
const PLAN_SLUG = 'dropi-roax'
const SUB_NAME = 'stores/s/subscription-plans/p/subscriptions/loc163-sub'
const WEBHOOK_KEY = 'loc163-confio-webhook-key'
const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
const FAILED_PROPS = ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'failedCount']
const SUCCEEDED_PROPS = ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'payment']

function signedCharge(status: 'FAILED' | 'SUCCEEDED') {
  const failed = status === 'FAILED'
  const data: Record<string, unknown> = {
    name: SUB_NAME,
    cycleNumber: 1,
    amountCents: 1990000,
    currencyCode: 'COP',
    status,
    ...(failed ? { failedCount: 1 } : { payment: 'loc163-payment' }),
  }
  const properties = failed ? FAILED_PROPS : SUCCEEDED_PROPS
  const timestamp = Math.floor(Date.now() / 1000)
  const concatenated =
    properties.map((p) => String(data[p])).join('') + String(timestamp) + WEBHOOK_KEY
  const checksum = createHash('sha256').update(concatenated).digest('hex').toUpperCase()
  return {
    event: 'subscription.billingStatusChanged',
    data,
    timestamp,
    signature: { properties, checksum },
  }
}

/** A failed charge on a signup not yet activated does not send a second payment link (LOC-163). */
describe('A failed Confio charge on a pending signup (PostgreSQL, LOC-163)', () => {
  let a: RaceInstance
  let app: INestApplication
  const originalEnv = process.env
  // R17: backend-roles is another service; true is what it answers when the move applies.
  const roles = {
    removePlanFromBrand: jest.fn().mockResolvedValue(true),
    assignPlanToBrand: jest.fn().mockResolvedValue(true),
  }
  // R17: Redis is remote; the case counts the payment link notices the retry would send.
  const publishNotification = jest.fn().mockResolvedValue(undefined)

  const clean = async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await a.dataSource.query(
      `DELETE FROM webhook_events WHERE provider = 'confio' AND payload -> 'data' ->> 'name' = $1`,
      [SUB_NAME],
    )
  }

  beforeAll(async () => {
    process.env = { ...originalEnv, CONFIO_WEBHOOK_KEY: WEBHOOK_KEY }
    a = await startInstance()
    const events = a.dataSource.getRepository(WebhookEvent)
    const confioSubscriptions = new ConfioSubscriptionWebhookService(
      a.dataSource.getRepository(Subscription),
      a.dataSource.getRepository(SubscriptionEvent),
      a.dataSource,
      // R17: ConfioPagos is external; only the paid charge reads the period from it.
      {
        getSubscription: jest.fn().mockResolvedValue({
          currentPeriodStart: new Date().toISOString(),
          currentPeriodEnd: PERIOD_END.toISOString(),
          nextBillingTime: PERIOD_END.toISOString(),
        }),
      } as any,
      roles as any,
      // R17: the cycle bonus has its own e2e; these signups give none.
      { plan: jest.fn().mockResolvedValue(null) } as any,
    )
    const webhook = new WebhookService(
      events,
      events,
      a.dataSource.getRepository(Payment),
      // R17: BullMQ needs Redis; no case here depends on a retry being queued.
      { add: jest.fn().mockResolvedValue(undefined) } as any,
      confioSubscriptions,
      new MercadoPagoProvider(),
    )
    webhook.setCheckoutService(a.checkout)

    Object.assign(a.moduleRef.get(EventBusService), { publishNotification })
    Object.assign(a.moduleRef.get(ProviderFactory), {
      // R17: ConfioPagos is external with cost; the retry gets a link without calling it.
      getProvider: () => ({
        createCheckout: jest.fn().mockResolvedValue({
          providerPaymentId: 'loc163-checkout',
          checkoutUrl: 'https://confio.test/loc163',
        }),
      }),
    })

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: WebhookService, useValue: webhook },
        // R17: Only the signed Confio route runs here; the other providers are not called.
        { provide: MercadoPagoProvider, useValue: {} },
        { provide: DropiProvider, useValue: {} },
        { provide: StripeProvider, useValue: {} },
        { provide: ConfioProvider, useValue: new ConfioProvider() },
      ],
    })
      // R17: Only admin routes use ApiAuthGuard; the Confio webhook is public and signed.
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = moduleRef.createNestApplication({ rawBody: true })
    await app.init()
  })

  beforeEach(async () => {
    await clean()
    roles.removePlanFromBrand.mockClear()
    roles.assignPlanToBrand.mockClear()
    publishNotification.mockClear()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      if (a) await clean()
    } finally {
      try {
        if (app) await app.close()
      } finally {
        await stopInstance(a)
        process.env = originalEnv
      }
    }
  })

  const seed = (overrides: Partial<Subscription>) =>
    seedSubscription(a.dataSource, BRAND_ID, {
      provider: SubscriptionProvider.CONFIO,
      providerSubscriptionId: SUB_NAME,
      walletId: null,
      autoRenew: true,
      retryCount: 0,
      ...overrides,
    })

  /** Posts the signed charge and waits until the handler has run, since the 200 comes first. */
  const deliver = async (status: 'FAILED' | 'SUCCEEDED') => {
    const res = await request(app.getHttpServer())
      .post('/webhook/confio')
      .set('content-type', 'application/json')
      .set('authorization', `Bearer ${WEBHOOK_KEY}`)
      .send(JSON.stringify(signedCharge(status)))
    expect(res.status).toBe(200)

    const deadline = Date.now() + 5000
    let row: WebhookEvent | null = null
    while (Date.now() < deadline) {
      row = await a.dataSource
        .getRepository(WebhookEvent)
        .createQueryBuilder('e')
        .where(`e.provider = 'confio'`)
        .andWhere(`e.payload -> 'data' ->> 'name' = :name`, { name: SUB_NAME })
        .andWhere(`e.payload -> 'data' ->> 'status' = :status`, { status })
        .getOne()
      if (row && row.status !== WebhookStatus.RECEIVED && row.status !== WebhookStatus.PROCESSING) {
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    expect(row?.status).toBe(WebhookStatus.PROCESSED)
  }

  const subscription = async (id: string) =>
    a.dataSource.getRepository(Subscription).findOneByOrFail({ id })

  const eventsOf = (subscriptionId: string) =>
    a.dataSource.getRepository(SubscriptionEvent).findBy({ subscriptionId })

  const paymentsOfBrand = () => a.dataSource.getRepository(Payment).countBy({ brandId: BRAND_ID })

  it('E1: a failed charge on a pending signup changes nothing and the retry cron sends nothing', async () => {
    // R15: red if planearCobro ignores pending again: the row goes past_due and the cron issues a payment.
    const sub = await seed({ status: SubscriptionStatus.PENDING })

    await deliver('FAILED')
    await elapseRetryBackoff(a.dataSource, sub.id)
    sweepOnlyBrands(a, [BRAND_ID])
    await a.tasks.retryFailedPayments()

    expect((await subscription(sub.id)).status).toBe(SubscriptionStatus.PENDING)
    expect(await eventsOf(sub.id)).toHaveLength(0)
    expect(await paymentsOfBrand()).toBe(0)
    expect(publishNotification).not.toHaveBeenCalled()
    expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
  })

  it('E2: a failed charge on an active subscription still goes past due and removes the plan', async () => {
    // R15: red if the pending guard also stops active rows: no past_due and no removal in roles.
    const sub = await seed({ status: SubscriptionStatus.ACTIVE })

    await deliver('FAILED')

    expect((await subscription(sub.id)).status).toBe(SubscriptionStatus.PAST_DUE)
    const events = await eventsOf(sub.id)
    expect(events).toHaveLength(1)
    expect(events[0].eventType).toBe(SubscriptionEventType.PAYMENT_FAILED)
    expect(roles.removePlanFromBrand).toHaveBeenCalledTimes(1)
    expect(roles.removePlanFromBrand).toHaveBeenCalledWith(BRAND_ID, PLAN_SLUG)
  })

  it('E3: a failed charge on a cancelled active subscription is ignored', async () => {
    // R15: red if the cancellation guard goes: the cancelled row turns into a live past_due debt.
    const sub = await seed({ status: SubscriptionStatus.ACTIVE, cancelledAt: new Date() })

    await deliver('FAILED')

    expect((await subscription(sub.id)).status).toBe(SubscriptionStatus.ACTIVE)
    expect(await eventsOf(sub.id)).toHaveLength(0)
    expect(roles.removePlanFromBrand).not.toHaveBeenCalled()
  })

  it('E4: a paid charge on a pending signup activates it and assigns the plan', async () => {
    // R15: red if the pending guard also stops paid charges: the row stays pending without its plan.
    const sub = await seed({ status: SubscriptionStatus.PENDING })

    await deliver('SUCCEEDED')

    expect((await subscription(sub.id)).status).toBe(SubscriptionStatus.ACTIVE)
    expect(roles.assignPlanToBrand).toHaveBeenCalledTimes(1)
    expect(roles.assignPlanToBrand).toHaveBeenCalledWith(BRAND_ID, PLAN_SLUG, PERIOD_END)
  })
})
