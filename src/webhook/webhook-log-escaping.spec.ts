import { Logger, RawBodyRequest } from '@nestjs/common'
import { Request } from 'express'

import { ClientRolesService } from '../client/client-roles.service'
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

/**
 * Doubles (R17): the repositories are in-memory stand-ins that never find a row, the retry queue
 * is never reached, and `ConfioProvider` only compares the one-shot bearer with the access token,
 * which is all the controller delegates to it. Controller, webhook service and Confio subscription
 * service are the real ones, so each line comes from the code that writes it in production.
 */
function realWebhookChain() {
  const subscriptionRepo = { findOne: jest.fn().mockResolvedValue(null) }
  const confioSubscriptions = new ConfioSubscriptionWebhookService(
    subscriptionRepo as any,
    {} as any,
    {} as any,
    {} as ConfioProvider,
    {} as ClientRolesService,
  )
  const writeRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((row: any) => ({ id: 'we-1', ...row })),
    save: jest.fn(async (row: any) => row),
  }
  const webhookService = new WebhookService(
    writeRepo as any,
    { findOne: jest.fn() } as any,
    { findOne: jest.fn().mockResolvedValue(null) } as any,
    { add: jest.fn() } as any,
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

    await confioSubscriptions.handle({ payload } as any)

    const unresolved = linesOf(warn).filter((line) => line.includes('suscripción no resuelta'))
    expect(unresolved).toEqual([
      'Confio suscripción no resuelta: name=stores/s%22 forged%3D1 correlationId=c%22%3D1',
    ])
  })

  it('keeps the bearer rejection line as it was', async () => {
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
})
