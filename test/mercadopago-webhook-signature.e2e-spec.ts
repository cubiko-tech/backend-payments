import { createHmac } from 'crypto'
import { INestApplication, Logger } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'
import { Repository } from 'typeorm'

import { Payment } from '../src/payment/entities/payment.entity'
import { ConfioProvider } from '../src/provider/confio/confio.provider'
import { DropiProvider } from '../src/provider/dropi/dropi.provider'
import { MercadoPagoProvider } from '../src/provider/mercadopago/mercadopago.provider'
import { StripeProvider } from '../src/provider/stripe/stripe.provider'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { WebhookEvent, WebhookStatus } from '../src/webhook/entities/webhookEvent.entity'
import { WebhookController } from '../src/webhook/webhook.controller'
import { WebhookService } from '../src/webhook/webhook.service'
import { RaceInstance, startInstance, stopInstance } from './support/wallet-race.fixture'

const SECRET = 'loc113-mp-webhook-secret'
const DATA_PREFIX = 'loc113-'
const TS_2001 = 1000000000

/** Signs like Mercado Pago: the manifest of `data.id` and `ts`, in the `x-signature` header. */
function sign(dataId: string, ts: number): string {
  const manifest = `id:${dataId};request-id:;ts:${ts};`
  return `ts=${ts},v1=${createHmac('sha256', SECRET).update(manifest).digest('hex')}`
}

describe('Mercado Pago webhook signature and deduplication (PostgreSQL, LOC-113)', () => {
  let a: RaceInstance
  let app: INestApplication
  let events: Repository<WebhookEvent>
  const originalSecret = process.env.MP_WEBHOOK_SECRET

  const rowsOf = (dataId: string) =>
    events
      .createQueryBuilder('e')
      .where("e.provider = 'mercadopago'")
      .andWhere(`e.payload -> 'data' ->> 'id' = :dataId`, { dataId })
      .getMany()

  const clean = () =>
    events.query(
      `DELETE FROM webhook_events WHERE provider = 'mercadopago'
         AND (payload -> 'data' ->> 'id' LIKE $1 OR payload ->> 'marker' LIKE $1)`,
      [`${DATA_PREFIX}%`],
    )

  /** The dispatch runs after the answer: wait until no row of this notification is still in flight. */
  const settled = async (dataId: string) => {
    const deadline = Date.now() + 5000
    let rows = await rowsOf(dataId)
    while (
      rows.some(
        (r) => r.status === WebhookStatus.RECEIVED || r.status === WebhookStatus.PROCESSING,
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      rows = await rowsOf(dataId)
    }
    return rows
  }

  const deliver = (body: object, signature: string) =>
    request(app.getHttpServer())
      .post('/webhook/mercadopago')
      .set('content-type', 'application/json')
      .set('x-signature', signature)
      .send(JSON.stringify(body))

  beforeAll(async () => {
    process.env.MP_WEBHOOK_SECRET = SECRET
    a = await startInstance()
    events = a.dataSource.getRepository(WebhookEvent)
    const webhook = new WebhookService(
      events,
      events,
      a.dataSource.getRepository(Payment),
      // R17: The retry queue needs Redis and only acts on a failed dispatch, which no case here has.
      { add: jest.fn() } as any,
      {} as any,
      // R17: Signature cases do not send `type: 'payment'`, so Mercado Pago status is not queried here.
      {} as any,
    )

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        MercadoPagoProvider,
        { provide: WebhookService, useValue: webhook },
        // R17: The other providers' routes are not called here; their real clients read env and network.
        { provide: StripeProvider, useValue: {} },
        { provide: DropiProvider, useValue: {} },
        { provide: ConfioProvider, useValue: {} },
      ],
    })
      // R17: Only the admin routes use this guard; the provider route under test does not pass through it.
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = moduleRef.createNestApplication({ rawBody: true })
    await app.init()
  })

  beforeEach(clean)

  afterAll(async () => {
    try {
      if (events) await clean()
    } finally {
      try {
        if (app) await app.close()
      } finally {
        await stopInstance(a)
        process.env.MP_WEBHOOK_SECRET = originalSecret
      }
    }
  })

  it('E7 accepts a fresh valid signature and stores one row', async () => {
    // R15: red if the route rejects a genuine signature: it answers 401 and stores nothing.
    const dataId = `${DATA_PREFIX}fresh`
    const ts = Math.floor(Date.now() / 1000)

    const res = await deliver(
      { id: 1, action: 'payment.updated', data: { id: dataId } },
      sign(dataId, ts),
    )

    expect(res.status).toBe(200)
    expect(await settled(dataId)).toHaveLength(1)
  })

  it('E1 rejects a valid signature with a ts from 2001 and stores nothing', async () => {
    // R15: red if the window goes away: the 2001 signature answers 200 and stores a row.
    const dataId = `${DATA_PREFIX}2001`

    const res = await deliver(
      { id: 2, action: 'payment.updated', data: { id: dataId } },
      sign(dataId, TS_2001),
    )

    expect(res.status).toBe(401)
    expect(await settled(dataId)).toHaveLength(0)
  })

  it('E4 keeps one row when the same signature arrives again with another top-level id', async () => {
    // R15: red if the key comes from the unsigned top-level id again: the second delivery adds a row.
    const dataId = `${DATA_PREFIX}replay`
    const signature = sign(dataId, Math.floor(Date.now() / 1000))

    const first = await deliver(
      { id: 10, action: 'payment.updated', data: { id: dataId } },
      signature,
    )
    const second = await deliver(
      { id: 11, action: 'payment.updated', data: { id: dataId } },
      signature,
    )

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.duplicate).toBe(true)
    expect(await settled(dataId)).toHaveLength(1)
  })

  it('E5 keys a notification without a top-level id by what is signed, never by the clock', async () => {
    // R15: red if the key falls back to the server clock: two deliveries make two rows.
    const dataId = `${DATA_PREFIX}no-id`
    const ts = Math.floor(Date.now() / 1000)
    const body = { action: 'payment.updated', data: { id: dataId } }

    await deliver(body, sign(dataId, ts))
    await deliver(body, sign(dataId, ts))

    const rows = await settled(dataId)
    expect(rows).toHaveLength(1)
    expect(rows[0].providerEventId).toBe(`mp:payment.updated:${dataId}:${ts}`)
  })

  it('E9 keeps payment.created and payment.updated of the same data.id and ts apart', async () => {
    // R15: red if the action leaves the key: the second notice is dropped as a duplicate.
    const dataId = `${DATA_PREFIX}two-actions`
    const signature = sign(dataId, Math.floor(Date.now() / 1000))

    await deliver({ action: 'payment.updated', data: { id: dataId } }, signature)
    const created = await deliver({ action: 'payment.created', data: { id: dataId } }, signature)

    expect(created.body.duplicate).toBeUndefined()
    expect(await settled(dataId)).toHaveLength(2)
  })

  it('E12 accepts a fresh valid signature whose ts is in milliseconds', async () => {
    // R15: red if a 13-digit ts is read as seconds again: the notice answers 401 and stores nothing.
    const dataId = `${DATA_PREFIX}fresh-ms`

    const res = await deliver(
      { action: 'payment.updated', data: { id: dataId } },
      sign(dataId, Date.now()),
    )

    expect(res.status).toBe(200)
    expect(await settled(dataId)).toHaveLength(1)
  })

  it('E13 rejects a valid signature with a ts from 2001 in milliseconds', async () => {
    // R15: red if the window skips millisecond ts: the 2001 signature answers 200 and stores a row.
    const dataId = `${DATA_PREFIX}2001-ms`

    const res = await deliver(
      { action: 'payment.updated', data: { id: dataId } },
      sign(dataId, TS_2001 * 1000),
    )

    expect(res.status).toBe(401)
    expect(await settled(dataId)).toHaveLength(0)
  })

  describe.each([
    { secret: 'configured', value: SECRET },
    { secret: 'not configured', value: undefined },
  ])('E11 with the secret $secret', ({ value }) => {
    beforeEach(() => {
      if (value) process.env.MP_WEBHOOK_SECRET = value
      else delete process.env.MP_WEBHOOK_SECRET
    })

    afterEach(() => {
      process.env.MP_WEBHOOK_SECRET = SECRET
      jest.restoreAllMocks()
    })

    const marker = `${DATA_PREFIX}object-field`
    const rowsWithMarker = () =>
      events
        .createQueryBuilder('e')
        .where("e.provider = 'mercadopago'")
        .andWhere(`e.payload ->> 'marker' = :marker`, { marker })
        .getCount()

    it.each([
      { field: 'action', body: { marker, action: { toString: 1 }, data: { id: marker } } },
      {
        field: 'data.id',
        body: { marker, action: 'payment.updated', data: { id: { toString: 1 } } },
      },
    ])('answers 401 to an object in $field, logs no error and stores nothing', async ({ body }) => {
      // R15: red if the field reaches `String()` unchecked: the route answers 500 and logs an error.
      const errors = jest.spyOn(Logger.prototype, 'error')

      const res = await deliver(body, 'ts=1,v1=a')

      expect(res.status).toBe(401)
      expect(errors).not.toHaveBeenCalled()
      expect(await rowsWithMarker()).toBe(0)
    })
  })
})
