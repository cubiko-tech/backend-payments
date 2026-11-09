import { createHash } from 'crypto'
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AuditService } from '../../src/audit/audit.service'
import { AuditLog } from '../../src/audit/entities/auditLog.entity'
import { ClientRolesService } from '../../src/client/client-roles.service'
import { Payment } from '../../src/payment/entities/payment.entity'
import { ConfioProvider } from '../../src/provider/confio/confio.provider'
import { DropiProvider } from '../../src/provider/dropi/dropi.provider'
import { MercadoPagoProvider } from '../../src/provider/mercadopago/mercadopago.provider'
import { StripeProvider } from '../../src/provider/stripe/stripe.provider'
import { ApiAuthGuard } from '../../src/shared/auth/api-auth.guard'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../../src/subscription/entities/subscriptionEvent.entity'
import { Transaction } from '../../src/transaction/entities/transaction.entity'
import { Wallet } from '../../src/wallet/entities/wallet.entity'
import { TokenWalletService } from '../../src/wallet/token-wallet.service'
import { ConfioSubscriptionWebhookService } from '../../src/webhook/confio-subscription-webhook.service'
import { WebhookEvent, WebhookStatus } from '../../src/webhook/entities/webhookEvent.entity'
import {
  SUBSCRIPTION_BONUS_REFERENCE,
  SubscriptionBonusService,
} from '../../src/webhook/subscription-bonus.service'
import { WebhookController } from '../../src/webhook/webhook.controller'
import { WebhookService } from '../../src/webhook/webhook.service'
import { seedSubscription } from './plan-lock.fixture'
import { cleanBrand, RaceInstance } from './wallet-race.fixture'

export const WEBHOOK_KEY = 'loc214-confio-webhook-key'
export const ROLES_URL = 'http://roles.loc214.test'
export const PERIOD_END = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
const SUCCEEDED_PROPS = ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'payment']
const FAILED_PROPS = ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'failedCount']

/** Resource name of the Confio subscription of `brandId` in these suites. */
export const subName = (brandId: string) => `stores/s/subscription-plans/p/subscriptions/${brandId}`

/** A charge notice signed with `WEBHOOK_KEY` the way ConfioPagos signs it. */
export function signedCharge(
  brandId: string,
  status: 'SUCCEEDED' | 'FAILED',
  cycleNumber = 1,
  attempt = 'loc214-payment-1',
  key = WEBHOOK_KEY,
) {
  const failed = status === 'FAILED'
  const data: Record<string, unknown> = {
    name: subName(brandId),
    cycleNumber,
    amountCents: 1990000,
    currencyCode: 'COP',
    status,
    ...(failed ? { failedCount: 1 } : { payment: attempt }),
  }
  const properties = failed ? FAILED_PROPS : SUCCEEDED_PROPS
  const timestamp = Math.floor(Date.now() / 1000)
  const concatenated = properties.map((p) => String(data[p])).join('') + String(timestamp) + key
  const checksum = createHash('sha256').update(concatenated).digest('hex').toUpperCase()
  return {
    event: 'subscription.billingStatusChanged',
    data,
    timestamp,
    signature: { properties, checksum },
  }
}

/** The plans `GET /v1/plan` answers: slug → `tokensPerCycle`. Tests change it between notices. */
export const catalog: { plans: Record<string, unknown>; down: boolean } = { plans: {}, down: false }

/**
 * Puts backend-roles behind `global.fetch`: the catalog from `catalog`, and 200 for every plan move.
 * R17: backend-roles is another service; the client that reads its answer stays real.
 */
export function answerAsRoles() {
  return jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    if (String(url) === `${ROLES_URL}/v1/plan`) {
      if (catalog.down) throw new Error('ECONNREFUSED')
      const data = Object.entries(catalog.plans).map(([slug, tokensPerCycle]) => ({
        slug,
        tokensPerCycle,
        prices: [],
      }))
      return new Response(JSON.stringify({ data }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

/** The real webhook chain of one instance: HTTP route, webhook service, bonus, wallet and audit. */
export interface BonusChain {
  app: INestApplication
  webhook: WebhookService
  confio: ConfioSubscriptionWebhookService
  roles: ClientRolesService
  dataSource: DataSource
}

export async function startBonusChain(instance: RaceInstance): Promise<BonusChain> {
  const ds = instance.dataSource
  const roles = new ClientRolesService()
  const tokens = new TokenWalletService(ds.getRepository(Wallet), ds)
  const audit = new AuditService(ds.getRepository(AuditLog), ds.getRepository(AuditLog))
  const confio = new ConfioSubscriptionWebhookService(
    ds.getRepository(Subscription),
    ds.getRepository(SubscriptionEvent),
    ds,
    // R17: ConfioPagos is external; it answers the period of the paid cycle and, for the active
    // confirmation, that the subscription is ACTIVE.
    {
      getSubscription: jest.fn().mockResolvedValue({
        status: 'ACTIVE',
        currentPeriodStart: new Date().toISOString(),
        currentPeriodEnd: PERIOD_END.toISOString(),
        nextBillingTime: PERIOD_END.toISOString(),
      }),
    } as any,
    roles,
    new SubscriptionBonusService(tokens, audit, roles),
  )
  const events = ds.getRepository(WebhookEvent)
  const webhook = new WebhookService(
    events,
    events,
    ds.getRepository(Payment),
    // R17: BullMQ needs Redis; a failed notice is retried here by `retryWebhook`.
    { add: jest.fn().mockResolvedValue(undefined) } as any,
    confio,
    new MercadoPagoProvider(),
  )

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
  const app = moduleRef.createNestApplication({ rawBody: true })
  await app.init()
  return { app, webhook, confio, roles, dataSource: ds }
}

export async function post(chain: BonusChain, payload: unknown): Promise<number> {
  const res = await request(chain.app.getHttpServer())
    .post('/webhook/confio')
    .set('content-type', 'application/json')
    .set('authorization', `Bearer ${WEBHOOK_KEY}`)
    .send(JSON.stringify(payload))
  return res.status
}

/** Waits until the stored notice of `brandId` with `attempt` leaves received/processing. */
export async function settled(ds: DataSource, brandId: string, attempt: string) {
  const deadline = Date.now() + 5000
  let row: WebhookEvent | null = null
  while (Date.now() < deadline) {
    row = await ds
      .getRepository(WebhookEvent)
      .createQueryBuilder('e')
      .where(`e.provider = 'confio'`)
      .andWhere(`e.payload -> 'data' ->> 'name' = :name`, { name: subName(brandId) })
      .andWhere(`e."providerEventId" LIKE :attempt`, { attempt: `%${attempt}` })
      .getOne()
    if (row && row.status !== WebhookStatus.RECEIVED && row.status !== WebhookStatus.PROCESSING) {
      return row
    }
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`Notice ${attempt} of ${brandId} did not settle: ${row?.status}`)
}

/** Posts a paid or failed charge and returns the stored notice once its handler ran. */
export async function deliver(
  chain: BonusChain,
  brandId: string,
  status: 'SUCCEEDED' | 'FAILED',
  cycleNumber = 1,
  attempt = 'loc214-payment-1',
) {
  expect(await post(chain, signedCharge(brandId, status, cycleNumber, attempt))).toBe(200)
  return settled(chain.dataSource, brandId, status === 'FAILED' ? 'intento-1' : attempt)
}

export const seedConfioSubscription = (ds: DataSource, brandId: string, planSlug: string) =>
  seedSubscription(ds, brandId, {
    provider: SubscriptionProvider.CONFIO,
    providerSubscriptionId: subName(brandId),
    planSlug,
    walletId: null,
    status: SubscriptionStatus.ACTIVE,
  })

export const tokenWalletOf = (ds: DataSource, brandId: string) =>
  ds.getRepository(Wallet).findOneBy({ brandId, provider: 'internal', currency: 'TKN' })

export const bonusesOf = (ds: DataSource, brandId: string) =>
  ds.getRepository(Transaction).findBy({ brandId, referenceType: SUBSCRIPTION_BONUS_REFERENCE })

export const auditOf = (ds: DataSource, walletId: string) =>
  ds.getRepository(AuditLog).findBy({ entityType: 'wallet', entityId: walletId })

export const eventsOf = (ds: DataSource, subscriptionId: string) =>
  ds.getRepository(SubscriptionEvent).findBy({ subscriptionId })

export async function cleanBonusBrand(ds: DataSource, brandId: string) {
  await cleanBrand(ds, brandId)
  await ds.query(
    `DELETE FROM webhook_events WHERE provider = 'confio' AND payload -> 'data' ->> 'name' = $1`,
    [subName(brandId)],
  )
}
