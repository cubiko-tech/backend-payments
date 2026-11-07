import { Logger, RawBodyRequest } from '@nestjs/common'
import { Queue } from 'bullmq'
import { Request } from 'express'
import { DataSource, Repository } from 'typeorm'

import { ClientRolesService } from '../client/client-roles.service'
import { Payment } from '../payment/entities/payment.entity'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { WebhookEvent } from './entities/webhookEvent.entity'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { buildConfioWebhookEventId } from '../provider/confio/confio-webhook'
import { DropiProvider } from '../provider/dropi/dropi.provider'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { StripeProvider } from '../provider/stripe/stripe.provider'
import { ConfioSubscriptionWebhookService } from './confio-subscription-webhook.service'
import { WebhookController } from './webhook.controller'
import { WebhookService } from './webhook.service'

const WEBHOOK_KEY = 'test-webhook-key'
const ACCESS_TOKEN = 'access-token-de-confio'

function rawRequest(payload: unknown): RawBodyRequest<Request> {
  return { rawBody: Buffer.from(JSON.stringify(payload)) } as RawBodyRequest<Request>
}

function linesOf(spy: jest.SpyInstance): string[] {
  return spy.mock.calls.map((call) => String(call[0]))
}

function noMarkerQueryBuilder() {
  const qb = {
    where: () => qb,
    andWhere: () => qb,
    getOne: async () => null,
  }
  return qb
}

/**
 * Doubles (R17): the repositories are in-memory stand-ins that find only `found`, the retry queue
 * is never reached, and `ConfioProvider` only compares the one-shot bearer with the access token,
 * which is all the controller delegates to it. Controller, webhook service and Confio subscription
 * service are the real ones, so each line comes from the code that writes it in production.
 */
function realWebhookChain(found: Subscription | null = null) {
  const subscriptionRepo = { findOne: jest.fn().mockResolvedValue(found) }
  const subscriptionEventRepo = { createQueryBuilder: noMarkerQueryBuilder }
  const confioSubscriptions = new ConfioSubscriptionWebhookService(
    subscriptionRepo as unknown as Repository<Subscription>,
    subscriptionEventRepo as unknown as Repository<SubscriptionEvent>,
    {} as DataSource,
    {} as ConfioProvider,
    {} as ClientRolesService,
  )
  const writeRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: object) => ({ id: 'we-1', ...row })),
    save: jest.fn(async (row: object) => row),
  }
  const webhookService = new WebhookService(
    writeRepo as unknown as Repository<WebhookEvent>,
    { findOne: jest.fn() } as unknown as Repository<WebhookEvent>,
    { findOne: jest.fn().mockResolvedValue(null) } as unknown as Repository<Payment>,
    { add: jest.fn() } as unknown as Queue,
    confioSubscriptions,
    {} as MercadoPagoProvider,
  )
  const confioProvider = {
    validateWebhookSignature: (_raw: Buffer, token: string) => token === ACCESS_TOKEN,
  }
  const controller = new WebhookController(
    webhookService,
    {} as StripeProvider,
    {} as MercadoPagoProvider,
    {} as DropiProvider,
    confioProvider as unknown as ConfioProvider,
  )

  return { controller, confioSubscriptions }
}

describe('Confio webhook log lines escape provider values', () => {
  const originalKey = process.env.CONFIO_WEBHOOK_KEY
  let warn: jest.SpyInstance
  let log: jest.SpyInstance

  beforeEach(() => {
    process.env.CONFIO_WEBHOOK_KEY = WEBHOOK_KEY
    // Spies on the real Nest logger capture each line; muted so the run output stays readable.
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation()
    jest.spyOn(Logger.prototype, 'error').mockImplementation()
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.CONFIO_WEBHOOK_KEY
    else process.env.CONFIO_WEBHOOK_KEY = originalKey
    jest.restoreAllMocks()
  })

  it('escapes an event outside the contract so it cannot forge a key=value pair', async () => {
    // Red if the ignored line logs `payload.event` raw: `forged=1` shows up loose.
    const { controller } = realWebhookChain()

    await controller.confio(
      `Bearer ${ACCESS_TOKEN}`,
      rawRequest({ event: 'x" forged=1', data: {} }),
    )

    const lines = linesOf(warn)
    expect(lines).toContain(
      'Webhook ConfioPagos ignorado: evento fuera del contrato "x%22 forged%3D1"',
    )
    expect(lines.join('\n')).not.toContain('forged=1')
  })

  it('logs one escaped unresolved-subscription line for an outside data.name', async () => {
    // Red if `data.name` goes back raw into the line: the newline splits it in two.
    const { confioSubscriptions } = realWebhookChain()
    const payload = {
      event: 'subscription.subscriptionStatusChanged',
      data: { name: 'stores/s"\nforged=1', correlationId: 'c"=1', status: 'ACTIVE' },
    }

    await confioSubscriptions.handle({ payload } as unknown as WebhookEvent)

    const unresolved = linesOf(warn).filter((line) => line.includes('suscripción no resuelta'))
    expect(unresolved).toEqual([
      'Confio suscripción no resuelta: name=stores/s%22 forged%3D1 correlationId=c%22%3D1',
    ])
  })

  it('keeps the bearer rejection line as it was', async () => {
    // Red if the rejection escapes its own fixed fields: `data=no aplica` turns into `data%3Dno aplica`.
    const { controller } = realWebhookChain()
    const signed = { event: 'subscription.billingStatusChanged', data: {}, timestamp: 1 }

    await controller.confio('Bearer wrong', rawRequest(signed)).catch(() => undefined)

    expect(linesOf(warn)).toContain(
      'Webhook ConfioPagos rechazado: reason=bearer_mismatch ' +
        'signature.properties=no aplica data=no aplica ' +
        'detail="el Authorization no coincide con CONFIO_WEBHOOK_KEY"',
    )
  })

  it('keeps the accepted webhook line as it was', async () => {
    // Red if `webhook.service.ts` drops the event id from the accepted line.
    const { controller } = realWebhookChain()
    const oneShot = {
      event: 'payment.statusChanged',
      data: { name: 'stores/01TESTSTORE/payments/01PAY', status: 'FUNDED' },
      timestamp: 1,
    }

    await controller.confio(`Bearer ${ACCESS_TOKEN}`, rawRequest(oneShot))
    // Let the fire-and-forget processing settle before the spies are restored.
    await new Promise((resolve) => setImmediate(resolve))

    const id = buildConfioWebhookEventId(oneShot as never)
    expect(linesOf(log)).toContain(`Webhook recibido: confio/payment.statusChanged (${id})`)
  })

  it('logs a failed charge on a pending subscription in one line when its status has a newline', async () => {
    // Red if `data.status` goes back raw into the pending line: the newline splits it in two.
    const pending = {
      id: 'sub-pending-1',
      provider: SubscriptionProvider.CONFIO,
      providerSubscriptionId: 'stores/01TESTSTORE/subscriptions/01SUB',
      status: SubscriptionStatus.PENDING,
    } as Subscription
    const { confioSubscriptions } = realWebhookChain(pending)
    const payload = {
      event: 'subscription.billingStatusChanged',
      data: { name: pending.providerSubscriptionId, status: 'FAILED\nforged=1' },
    }

    await confioSubscriptions.handle({ payload, providerEventId: 'ev-1' } as WebhookEvent)

    const pendingLines = linesOf(log).filter((line) => line.includes('still pending subscription'))
    expect(pendingLines).toEqual([
      'Confio failed charge on a still pending subscription (sub-pending-1): ' +
        'no effect, status=FAILED forged%3D1',
    ])
  })
})
