/**
 * What a recharge from Dropi tells New Relic, over HTTP against PostgreSQL (LOC-181): one
 * `DropiRecharge` event when it is born and one when this call closes it, with no personal data,
 * and the minute sweep that reports how many are pending and the age of the oldest.
 */
import { HttpStatus } from '@nestjs/common'
import { config as dotenvConfig } from 'dotenv'

import { Payment } from '../src/payment/entities/payment.entity'
import { DropiRechargeSignal } from '../src/recharge/dropi-recharge-signal'
import { DropiRechargeBacklogTask } from '../src/tasks/dropi-recharge-backlog'
import {
  ACCESS_SERVER,
  ADS_KEY,
  cleanBillingProfile,
  forgetCachedTrm,
  JWT_SECRET,
  MEMBER_ID,
  postRecharge,
  postResult,
  RechargeApp,
  startRechargeApp,
} from './support/dropi-recharge.fixture'
import { startTrmSource, trmOk, TrmSource } from './support/trm-source.fixture'
import {
  cleanBrand,
  RaceInstance,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const RECHARGE_BRAND = 'a1810000-0000-4000-8000-0000000000e1'
const REQUEST_ID = 'b1810000-0000-4000-8000-000000000001'
const OTHER_REQUEST_ID = 'b1810000-0000-4000-8000-000000000002'
const EVENT_FIELDS = ['ageSeconds', 'amountCop', 'rechargeId', 'status', 'tokens']

describe('A recharge from Dropi leaves a New Relic signal (PostgreSQL, LOC-181)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let trm: TrmSource
  let recharge: RechargeApp
  let member = ''

  const create = (requestId = REQUEST_ID) =>
    postRecharge(recharge, { brandId: RECHARGE_BRAND, tokens: 10, requestId }, member)
  const close = (id: string, amount: number, status: 'charged' | 'failed') =>
    postResult(recharge, id, {
      brandId: RECHARGE_BRAND,
      status,
      amount,
      dropiOperationId: `dropi-op-${status}`,
    })
  const events = () => recharge.apm.events.filter((event) => event.type === 'DropiRecharge')
  const bornAgo = (id: string, seconds: number) =>
    a.dataSource.query(
      `UPDATE payments SET "createdAt" = now() - make_interval(secs => $2) WHERE id = $1`,
      [id, seconds],
    )
  const clean = async () => {
    await cleanBrand(a.dataSource, RECHARGE_BRAND)
    await cleanBillingProfile(a.dataSource, RECHARGE_BRAND)
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER })
    a = await startInstance()
    trm = await startTrmSource()
    recharge = await startRechargeApp(a.dataSource, trm, RECHARGE_BRAND)
    member = recharge.jwt.sign({ id: MEMBER_ID, isSuperAdmin: false, brand: RECHARGE_BRAND })
  })

  beforeEach(async () => {
    await clean()
    trm.reply = trmOk
    forgetCachedTrm(recharge)
    recharge.apm.events.length = 0
  })

  afterAll(async () => {
    await clean()
    await recharge?.app.close()
    await trm?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it('a new recharge of 10 tokens leaves one pending event with no personal data', async () => {
    // R15: red when the event adds the user (userId or email): its field list is not the five.
    const res = await create()

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(events()).toHaveLength(1)
    const [{ attributes }] = events()
    expect(Object.keys(attributes).sort()).toEqual(EVENT_FIELDS)
    expect(attributes).toMatchObject({
      rechargeId: res.body.data.id,
      status: 'pending',
      tokens: 10,
      amountCop: res.body.data.amount,
    })
    const values = Object.values(attributes).map(String)
    expect(values).not.toEqual(expect.arrayContaining([MEMBER_ID, member, ADS_KEY]))
  })

  it('the same request again is the same recharge and leaves no second event', async () => {
    // R15: red when the event is recorded for a replayed request: two pending events.
    await create()
    const again = await create()

    expect(again.status).toBe(HttpStatus.OK)
    expect(events()).toHaveLength(1)
  })

  it('charged and, on another recharge, failed each leave one event with its status and age', async () => {
    // R15: red when the close stops recording the event: no charged or failed event is seen.
    const first = (await create()).body.data
    const second = (await create(OTHER_REQUEST_ID)).body.data
    await bornAgo(first.id, 90)
    await bornAgo(second.id, 120)

    const charged = await close(first.id, first.amount, 'charged')
    const failed = await close(second.id, second.amount, 'failed')

    expect([charged.status, failed.status]).toEqual([HttpStatus.OK, HttpStatus.OK])
    const closes = events().filter((event) => event.attributes.status !== 'pending')
    expect(closes.map(({ attributes }) => [attributes.rechargeId, attributes.status])).toEqual([
      [first.id, 'charged'],
      [second.id, 'failed'],
    ])
    const [chargedAge, failedAge] = closes.map(({ attributes }) => Number(attributes.ageSeconds))
    expect(chargedAge).toBeGreaterThanOrEqual(90)
    expect(chargedAge).toBeLessThan(120)
    expect(failedAge).toBeGreaterThanOrEqual(120)
  })

  it('a charged report replayed leaves only the close of the call that closed it', async () => {
    // R15: red when a replayed charge records the event again: two charged events.
    const created = (await create()).body.data
    await close(created.id, created.amount, 'charged')
    const replay = await close(created.id, created.amount, 'charged')

    expect(replay.status).toBe(HttpStatus.OK)
    expect(events().filter((event) => event.attributes.status === 'charged')).toHaveLength(1)
  })

  it('a failing agent does not fail the recharge: it is still charged', async () => {
    // R15: red when the signal lets the agent error through: the report answers 500.
    const created = (await create()).body.data
    const record = jest.spyOn(recharge.apm, 'recordCustomEvent').mockImplementation(() => {
      throw new Error('agent down')
    })
    try {
      const res = await close(created.id, created.amount, 'charged')

      expect(res.status).toBe(HttpStatus.OK)
      expect(res.body.data.status).toBe('completed')
    } finally {
      record.mockRestore()
    }
  })

  describe('the minute sweep', () => {
    const now = new Date()
    const backlog = () => recharge.apm.events.filter((e) => e.type === 'DropiRechargeBacklog')

    /**
     * Runs the sweep in a transaction rolled back afterwards, with every other pending recharge
     * failed inside it, so rows left in the shared database by others never count.
     */
    async function sweepAlone(pending: { id: string; minutes: number }[]) {
      const runner = a.dataSource.createQueryRunner()
      await runner.startTransaction()
      try {
        await runner.query(
          `UPDATE payments SET status = 'failed'
           WHERE provider = 'dropi_wallet' AND status = 'pending' AND NOT (id = ANY($1::uuid[]))`,
          [pending.map(({ id }) => id)],
        )
        for (const { id, minutes } of pending) {
          const createdAt = new Date(now.getTime() - minutes * 60_000)
          await runner.query('UPDATE payments SET "createdAt" = $2 WHERE id = $1', [id, createdAt])
        }
        const signal = recharge.moduleRef.get(DropiRechargeSignal)
        await new DropiRechargeBacklogTask(runner.manager.getRepository(Payment), signal).run(now)
      } finally {
        await runner.rollbackTransaction()
        await runner.release()
      }
    }

    it('two pending recharges of 5 and 40 minutes count 2 and 2,400 seconds', async () => {
      // R15: red when the sweep takes the newest instead of the oldest: it reports 300 seconds.
      const first = (await create()).body.data
      const second = (await create(OTHER_REQUEST_ID)).body.data

      await sweepAlone([
        { id: first.id, minutes: 5 },
        { id: second.id, minutes: 40 },
      ])

      expect(backlog().map((event) => event.attributes)).toEqual([
        { pending: 2, oldestPendingSeconds: 2400 },
      ])
    })

    it('a closed recharge is not pending: one charged and one pending count 1', async () => {
      // R15: red when the sweep drops its pending filter: the charged recharge counts too.
      const charged = (await create()).body.data
      const pending = (await create(OTHER_REQUEST_ID)).body.data
      await close(charged.id, charged.amount, 'charged')

      await sweepAlone([
        { id: charged.id, minutes: 50 },
        { id: pending.id, minutes: 10 },
      ])

      expect(backlog().map((event) => event.attributes)).toEqual([
        { pending: 1, oldestPendingSeconds: 600 },
      ])
    })

    it('with no pending recharge it reports 0 and 0', async () => {
      // R15: red when an empty sweep reads a missing oldest as a date: oldest is not 0.
      await sweepAlone([])

      expect(backlog().map((event) => event.attributes)).toEqual([
        { pending: 0, oldestPendingSeconds: 0 },
      ])
    })
  })
})
