import { createHash } from 'crypto'
import * as request from 'supertest'

import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { WebhookEvent, WebhookStatus } from '../src/webhook/entities/webhookEvent.entity'
import {
  answerAsRoles,
  BonusChain,
  bonusesOf,
  catalog,
  cleanBonusBrand,
  post,
  ROLES_URL,
  seedConfioSubscription,
  settled,
  startBonusChain,
  subName,
  WEBHOOK_KEY,
} from './support/subscription-bonus.fixture'
import { RaceInstance, startInstance, stopInstance } from './support/wallet-race.fixture'

const BRAND = 'b2720272-1111-4333-8444-555555555272'
const CHARGE_PROPS = ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'payment']
const NOW_S = () => Math.floor(Date.now() / 1000)

/** A notice signed with `WEBHOOK_KEY` the way ConfioPagos signs it. */
function signed(
  event: string,
  data: Record<string, unknown>,
  properties: string[],
  timestamp: number,
) {
  const concatenated =
    properties.map((p) => String(data[p])).join('') + String(timestamp) + WEBHOOK_KEY
  const checksum = createHash('sha256').update(concatenated).digest('hex').toUpperCase()
  return { event, data, timestamp, signature: { properties, checksum } }
}

const paidCycle = (cycleNumber: number, amountCents: number, timestamp = NOW_S()) =>
  signed(
    'subscription.billingStatusChanged',
    {
      name: subName(BRAND),
      cycleNumber,
      amountCents,
      currencyCode: 'COP',
      status: 'SUCCEEDED',
      payment: `loc272-payment-${cycleNumber}`,
    },
    CHARGE_PROPS,
    timestamp,
  )

const statusChange = (status: string, timestamp: number) =>
  signed(
    'subscription.subscriptionStatusChanged',
    { name: subName(BRAND), status },
    ['name', 'status'],
    timestamp,
  )

/** backend-roles answering 500 to everything: the catalog and every plan move. */
function rolesDown() {
  // R17: backend-roles is another service; the client that reads its answer stays real.
  return jest
    .spyOn(global, 'fetch')
    .mockImplementation(async () => new Response('{}', { status: 500 }))
}

/** LOC-272: the Confio subscription notice applies in order, keeps its trace when roles is down. */
describe('Confio subscription notices in order and with their trace (PostgreSQL, LOC-272)', () => {
  let instance: RaceInstance
  let chain: BonusChain
  const originalEnv = process.env

  beforeAll(async () => {
    process.env = { ...originalEnv, CONFIO_WEBHOOK_KEY: WEBHOOK_KEY, SERVICE_ROLES: ROLES_URL }
    instance = await startInstance()
    chain = await startBonusChain(instance)
  })

  beforeEach(async () => {
    await cleanBonusBrand(ds(), BRAND)
    catalog.plans = { 'pro-500': 500 }
    catalog.down = false
    chain.roles.invalidateCache()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      if (instance) await cleanBonusBrand(ds(), BRAND)
    } finally {
      await chain?.app.close()
      await stopInstance(instance)
      process.env = originalEnv
    }
  })

  const ds = () => instance.dataSource
  const rowOf = (id: string) => ds().getRepository(Subscription).findOneByOrFail({ id })
  const tracesOf = (subscriptionId: string) =>
    ds()
      .getRepository(SubscriptionEvent)
      .find({ where: { subscriptionId }, order: { createdAt: 'ASC' } })
  const noticesOf = () =>
    ds()
      .getRepository(WebhookEvent)
      .createQueryBuilder('e')
      .where(`e.payload -> 'data' ->> 'name' = :name`, { name: subName(BRAND) })
      .orderBy('e."createdAt"', 'ASC')
      .getMany()

  /** `settled` matches by suffix, and the ignored key ends like the one-shot one: this waits by the key. */
  async function settledByKey(providerEventId: string) {
    const deadline = Date.now() + 5000
    let row: WebhookEvent | null = null
    while (Date.now() < deadline) {
      row = await ds()
        .getRepository(WebhookEvent)
        .findOneBy({ provider: 'confio', providerEventId })
      if (row && row.status !== WebhookStatus.RECEIVED && row.status !== WebhookStatus.PROCESSING)
        return row
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    throw new Error(`Notice ${providerEventId} did not settle: ${row?.status}`)
  }

  it('scenario 1: an EXPIRED signed before the applied charge keeps the row active', async () => {
    // R15: red if the watermark check is removed: the row is downgraded to expired and roles gets it.
    const sub = await seedConfioSubscription(ds(), BRAND, 'pro-500')
    const roles = answerAsRoles()
    const chargedAt = NOW_S()
    expect(await post(chain, paidCycle(1, 1990000, chargedAt))).toBe(200)
    expect((await settled(ds(), BRAND, 'loc272-payment-1')).status).toBe(WebhookStatus.PROCESSED)
    const rolesCallsAfterCharge = roles.mock.calls.length

    expect(await post(chain, statusChange('EXPIRED', chargedAt - 600))).toBe(200)
    const late = await settled(ds(), BRAND, `EXPIRED:${chargedAt - 600}`)

    expect(late.status).toBe(WebhookStatus.OUT_OF_ORDER)
    const row = await rowOf(sub.id)
    expect(row.status).toBe(SubscriptionStatus.ACTIVE)
    expect(row.autoRenew).toBe(true)
    expect(row.providerWatermark).toEqual({
      name: subName(BRAND),
      cycle: 1,
      at: new Date(chargedAt * 1000).toISOString(),
    })
    expect(roles.mock.calls.length).toBe(rolesCallsAfterCharge)
    const traces = await tracesOf(sub.id)
    expect(traces.map((t) => t.eventType)).toEqual(['payment_succeeded'])
  })

  it('scenario 2 and 6: with roles down the trace stays pending, and the retry applies it once', async () => {
    // R15: red if the trace is written after roles (scenario 2 finds no row), or if the marker reads
    // a pending trace as applied (scenario 6: the retry applies nothing).
    const sub = await seedConfioSubscription(ds(), BRAND, 'pro-500')
    const before = await rowOf(sub.id)
    rolesDown()

    expect(await post(chain, paidCycle(1, 1990000))).toBe(200)
    const failed = await settled(ds(), BRAND, 'loc272-payment-1')

    expect(failed.status).toBe(WebhookStatus.FAILED)
    expect(failed.retryCount).toBe(1)
    expect(failed.error).toEqual(expect.any(String))
    const [pending, ...others] = await tracesOf(sub.id)
    expect(others).toHaveLength(0)
    expect(pending.traceStatus).toBe('pending')
    expect(pending.eventType).toBe('payment_succeeded')
    expect(pending.metadata.providerEventId).toBe(failed.providerEventId)
    const unchanged = await rowOf(sub.id)
    expect(unchanged.currentPeriodEnd).toEqual(before.currentPeriodEnd)
    expect(unchanged.providerWatermark).toBeNull()
    expect(await bonusesOf(ds(), BRAND)).toHaveLength(0)

    jest.restoreAllMocks()
    answerAsRoles()
    await chain.webhook.retryWebhook(failed.id)
    const retried = await settled(ds(), BRAND, 'loc272-payment-1')

    expect(retried.status).toBe(WebhookStatus.PROCESSED)
    const [applied, ...rest] = await tracesOf(sub.id)
    expect(rest).toHaveLength(0)
    expect(applied.id).toBe(pending.id)
    expect(applied.traceStatus).toBe('applied')
    expect(applied.metadata.signatureChecksum).toEqual(expect.any(String))
    expect((await rowOf(sub.id)).providerWatermark).toEqual(expect.objectContaining({ cycle: 1 }))
    expect(await bonusesOf(ds(), BRAND)).toHaveLength(1)
  })

  /** An unsigned Confio event with `data` of the brand, sent with the webhook key. */
  const sendUnsigned = (event: string) =>
    request(chain.app.getHttpServer())
      .post('/webhook/confio')
      .set('content-type', 'application/json')
      .set('authorization', `Bearer ${WEBHOOK_KEY}`)
      .send(
        JSON.stringify({
          event,
          data: { name: subName(BRAND), status: 'FUNDED' },
          timestamp: NOW_S(),
        }),
      )

  it('scenario 3: an event outside the contract answers 200 and is kept ignored, not dispatched', async () => {
    // R15: red if the controller answers without keeping the event: no row is found.
    const sub = await seedConfioSubscription(ds(), BRAND, 'pro-500')

    const ignored = await sendUnsigned('invoice.created')

    expect(ignored.status).toBe(200)
    expect(ignored.body).toEqual({ ignored: true })
    const [kept, ...more] = await noticesOf()
    expect(more).toHaveLength(0)
    expect(kept.status).toBe(WebhookStatus.IGNORED)
    expect(kept.eventType).toBe('invoice.created')
    expect(kept.retryCount).toBe(0)
    expect(await tracesOf(sub.id)).toEqual([])
    expect((await rowOf(sub.id)).status).toBe(SubscriptionStatus.ACTIVE)
  })

  it('scenario 9: an ignored event never takes the key of the one-shot notice with the same data', async () => {
    // R15: red if the ignored event keeps the one-shot key: the payment notice is dropped as a duplicate.
    await seedConfioSubscription(ds(), BRAND, 'pro-500')
    expect((await sendUnsigned('invoice.created')).status).toBe(200)

    expect((await sendUnsigned('payment.statusChanged')).status).toBe(200)

    const oneShot = await settledByKey(`${subName(BRAND)}:FUNDED`)
    expect(oneShot.eventType).toBe('payment.statusChanged')
    expect(oneShot.status).toBe(WebhookStatus.PROCESSED)
    const ignored = await ds()
      .getRepository(WebhookEvent)
      .findOneByOrFail({ provider: 'confio', eventType: 'invoice.created' })
    expect(ignored.providerEventId).toBe(`ignored:invoice.created:${subName(BRAND)}:FUNDED`)
  })

  it('scenario 4: a cycle charged 0 restores the plan without a bonus', async () => {
    // R15: red if `plan` stops reading `amountCents`: the brand gets 500 tokens for a 0 charge.
    const sub = await seedConfioSubscription(ds(), BRAND, 'pro-500')
    await ds().getRepository(Subscription).update(sub.id, { status: SubscriptionStatus.PAST_DUE })
    const roles = answerAsRoles()

    expect(await post(chain, paidCycle(2, 0))).toBe(200)
    const notice = await settled(ds(), BRAND, 'loc272-payment-2')

    expect(notice.status).toBe(WebhookStatus.PROCESSED)
    expect((await rowOf(sub.id)).status).toBe(SubscriptionStatus.ACTIVE)
    const assigned = roles.mock.calls.filter(
      ([url, init]) =>
        String(url).includes(`/v1/brand/${BRAND}/plan`) &&
        (init as RequestInit)?.method !== 'DELETE',
    )
    expect(assigned.length).toBeGreaterThan(0)
    expect(await bonusesOf(ds(), BRAND)).toHaveLength(0)
  })

  it('scenario 5: a paid cycle delivered twice, the second re-split, gives one bonus', async () => {
    // R15: red if the bonus refusal is skipped: the re-split notice credits a second bonus.
    const sub = await seedConfioSubscription(ds(), BRAND, 'pro-500')
    answerAsRoles()
    const notice = paidCycle(3, 1990000)
    // LOC-235: a digit moved from `amountCents` to `cycleNumber` keeps the checksum and mints a new key.
    const resplit = {
      ...notice,
      data: { ...notice.data, cycleNumber: 31, amountCents: 990000 },
    }
    const keyOf = (cycle: number) =>
      `${subName(BRAND)}:subscription.billingStatusChanged:ciclo-${cycle}:SUCCEEDED:loc272-payment-3`

    expect(await post(chain, notice)).toBe(200)
    expect((await settledByKey(keyOf(3))).status).toBe(WebhookStatus.PROCESSED)
    expect(await post(chain, resplit)).toBe(200)
    const second = await settledByKey(keyOf(31))

    expect(second.status).toBe(WebhookStatus.PROCESSED)
    const [bonus, ...more] = await bonusesOf(ds(), BRAND)
    expect(more).toHaveLength(0)
    expect(Number(bonus.amount)).toBe(500)
    expect(bonus.metadata.cycleNumber).toBe(3)
    expect((await rowOf(sub.id)).status).toBe(SubscriptionStatus.ACTIVE)
  })
})
