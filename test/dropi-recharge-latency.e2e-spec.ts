/**
 * `POST /recharge/dropi` answers within its 8 s budget when an upstream accepts the connection and
 * never answers (LOC-189): auth, platform and the TRM each give up at their share with a 503, and
 * nothing is saved. Each upstream is a local server that holds the request; Postgres is real.
 */
import { HttpStatus } from '@nestjs/common'
import { config as dotenvConfig } from 'dotenv'

import {
  ACCESS_SERVER,
  JWT_SECRET,
  MEMBER_ID,
  postRecharge,
  RechargeApp,
  rechargesOf,
  startRechargeApp,
} from './support/dropi-recharge.fixture'
import { SilentUpstream, startSilentUpstream } from './support/silent-upstream.fixture'
import { startTrmSource, TrmSource } from './support/trm-source.fixture'
import {
  cleanBrand,
  RaceInstance,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'a1890000-0000-4000-8000-0000000000e2'
// One budget share plus slack for the app itself; the whole route is capped at 8 s.
const SLACK_MS = 1000
// A mutation that drops a cap waits the 10 s default: the case must outlive it to see the red.
const CASE_TIMEOUT_MS = 15_000

describe('Recharge from Dropi answers within its budget (PostgreSQL, LOC-189)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let silent: SilentUpstream
  let trm: TrmSource
  let stalledPeers: RechargeApp
  let stalledTrm: RechargeApp

  const body = { brandId: BRAND, tokens: 10, requestId: 'b1890000-0000-4000-8000-000000000001' }
  const timed = async (call: () => Promise<{ status: number; body: { code?: string } }>) => {
    const started = Date.now()
    const res = await call()
    return { status: res.status, code: res.body.code, ms: Date.now() - started }
  }

  beforeAll(async () => {
    silent = await startSilentUpstream()
    trm = await startTrmSource()
    Object.assign(process.env, {
      JWT_SECRET,
      ACCESS_SERVER,
      SERVICE_AUTH: silent.url,
      SERVICE_PLATFORM: silent.url,
    })
    a = await startInstance()
    stalledPeers = await startRechargeApp(a.dataSource, trm, BRAND, { realPlatform: true })
    stalledTrm = await startRechargeApp(a.dataSource, { url: `${silent.url}/trm.json` }, BRAND)
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND))

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND)
    await stalledPeers?.app.close()
    await stalledTrm?.app.close()
    await silent?.close()
    await trm?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it(
    'answers 503 within 2 s when auth does not answer about the user token, and saves nothing',
    async () => {
      // R15: red when the route loses @UpstreamTimeout: auth waits 10 s and the call gets 401.
      // Signed with another secret, so only auth can check it.
      const token = stalledPeers.jwt.sign({ id: MEMBER_ID, client: 'dropi' }, { secret: 'other' })

      const res = await timed(() => postRecharge(stalledPeers, body, token))

      expect([res.status, res.code]).toEqual([HttpStatus.SERVICE_UNAVAILABLE, 'AUTH_UNAVAILABLE'])
      expect(res.ms).toBeLessThan(2000 + SLACK_MS)
      expect(await rechargesOf(a.dataSource, BRAND)).toHaveLength(0)
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'answers 503 within 2 s when platform accepts the connection and does not answer, and saves nothing',
    async () => {
      // R15: red when canViewBrandCredit loses its 2 s here: it waits the 10 s default.
      const member = stalledPeers.jwt.sign({ id: MEMBER_ID, isSuperAdmin: false, brand: BRAND })
      const hitsBefore = silent.hits

      const res = await timed(() => postRecharge(stalledPeers, body, member))

      expect(silent.hits).toBe(hitsBefore + 1)
      expect([res.status, res.code]).toEqual([
        HttpStatus.SERVICE_UNAVAILABLE,
        'BRAND_LOOKUP_UNAVAILABLE',
      ])
      expect(res.ms).toBeLessThan(2000 + SLACK_MS)
      expect(trm.hits).toBe(0)
      expect(await rechargesOf(a.dataSource, BRAND)).toHaveLength(0)
    },
    CASE_TIMEOUT_MS,
  )

  it(
    'answers 503 within 3 s when the TRM source does not answer, and saves nothing',
    async () => {
      // R15: red when create stops passing RECHARGE_TRM_TIMEOUT_MS: it waits the 5 s query timeout.
      const member = stalledTrm.jwt.sign({ id: MEMBER_ID, isSuperAdmin: false, brand: BRAND })

      const res = await timed(() => postRecharge(stalledTrm, body, member))

      expect([res.status, res.code]).toEqual([
        HttpStatus.SERVICE_UNAVAILABLE,
        'EXCHANGE_RATE_UNAVAILABLE',
      ])
      expect(res.ms).toBeLessThan(3000 + SLACK_MS)
      expect(await rechargesOf(a.dataSource, BRAND)).toHaveLength(0)
    },
    CASE_TIMEOUT_MS,
  )
})
