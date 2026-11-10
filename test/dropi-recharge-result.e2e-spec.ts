/**
 * The result of a recharge from Dropi over HTTP against PostgreSQL (LOC-175): `charged` credits its
 * tokens to the `dropi` origin once, `failed` closes it with none, and what does not match is refused.
 */
import { HttpStatus } from '@nestjs/common'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'

import { Payment, PaymentStatus } from '../src/payment/entities/payment.entity'
import { TokenOrigin } from '../src/wallet/token-origin'
import {
  ACCESS_SERVER,
  auditOf,
  cleanBillingProfile,
  creditsOf,
  forgetCachedTrm,
  JWT_SECRET,
  MEMBER_ID,
  postRecharge,
  postResult,
  RechargeApp,
  startRechargeApp,
  tokenWalletOf,
} from './support/dropi-recharge.fixture'
import { startTrmSource, trmOk, TrmSource } from './support/trm-source.fixture'
import {
  cleanBrand,
  RaceInstance,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const RECHARGE_BRAND = 'a1750000-0000-4000-8000-0000000000e1'
const OTHER_BRAND = 'a1750000-0000-4000-8000-0000000000e9'
const REQUEST_ID = 'b1750000-0000-4000-8000-000000000001'

describe('The result of a recharge from Dropi closes it once (PostgreSQL, LOC-175)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let trm: TrmSource
  let recharge: RechargeApp
  let member = ''
  let id = ''
  let amount = 0

  const charged = (overrides: object = {}) => ({
    brandId: RECHARGE_BRAND,
    status: 'charged',
    amount,
    dropiOperationId: 'dropi-op-1',
    ...overrides,
  })
  const failed = (overrides: object = {}) => ({
    brandId: RECHARGE_BRAND,
    status: 'failed',
    amount,
    ...overrides,
  })
  const report = (body: object) => postResult(recharge, id, body)
  const stored = () => a.dataSource.getRepository(Payment).findOneByOrFail({ id })
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
    const created = await postRecharge(
      recharge,
      { brandId: RECHARGE_BRAND, tokens: 10, requestId: REQUEST_ID },
      member,
    )
    expect(created.status).toBe(HttpStatus.CREATED)
    id = created.body.data.id
    amount = created.body.data.amount
  })

  afterAll(async () => {
    await clean()
    await recharge?.app.close()
    await trm?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it('CA2: charged twice credits 10 tokens once and the second report changes nothing', async () => {
    // R15: red when a completed recharge stops replaying the same charge: the second gets 409.
    const first = await report(charged())
    const second = await report(charged())

    expect([first.status, second.status]).toEqual([HttpStatus.OK, HttpStatus.OK])
    expect(second.body.data).toEqual(first.body.data)
    expect(first.body.data.status).toBe(PaymentStatus.COMPLETED)
    expect(Number((await tokenWalletOf(a.dataSource, RECHARGE_BRAND)).balance)).toBe(10)
    expect(await creditsOf(a.dataSource, id)).toHaveLength(1)
    expect(await auditOf(a.dataSource, id)).toHaveLength(1)
  })

  it('a charged report with another Dropi operation id on a completed recharge gets 409', async () => {
    // R15: red when a completed recharge replays any charge: the other operation gets 200.
    await report(charged())
    const other = await report(charged({ dropiOperationId: 'dropi-op-2' }))

    expect(other.status).toBe(HttpStatus.CONFLICT)
    expect(other.body.code).toBe('RECHARGE_ALREADY_CLOSED')
    expect((await stored()).providerPaymentId).toBe('dropi-op-1')
    expect(Number((await tokenWalletOf(a.dataSource, RECHARGE_BRAND)).balance)).toBe(10)
  })

  it('CA2: failed closes the recharge with no tokens and its audit', async () => {
    // R15: red when the failed branch credits like charged: the wallet holds 10 tokens.
    const res = await report(failed({ dropiOperationId: 'dropi-op-9' }))

    expect(res.status).toBe(HttpStatus.OK)
    const payment = await stored()
    expect(payment.status).toBe(PaymentStatus.FAILED)
    expect(payment.providerPaymentId).toBeNull()
    expect(payment.metadata.dropiOperationId).toBe('dropi-op-9')
    expect(payment.metadata.dropiRecharge.tokens).toBe(10)
    expect(Number((await tokenWalletOf(a.dataSource, RECHARGE_BRAND)).balance)).toBe(0)
    expect(await creditsOf(a.dataSource, id)).toHaveLength(0)
    expect((await auditOf(a.dataSource, id)).map((row) => row.action)).toEqual([
      'dropi_recharge_failed',
    ])
  })

  it('failed twice answers 200 both times and audits once', async () => {
    // R15: red when a failed recharge stops replaying a failure: the second gets 409.
    const first = await report(failed())
    const second = await report(failed())

    expect([first.status, second.status]).toEqual([HttpStatus.OK, HttpStatus.OK])
    expect(await auditOf(a.dataSource, id)).toHaveLength(1)
  })

  it('a charged report on a failed recharge gets 409 and credits nothing', async () => {
    // R15: red when the state check goes: the failed recharge is credited 10 tokens.
    await report(failed())
    const late = await report(charged())

    expect(late.status).toBe(HttpStatus.CONFLICT)
    expect((await stored()).status).toBe(PaymentStatus.FAILED)
    expect(Number((await tokenWalletOf(a.dataSource, RECHARGE_BRAND)).balance)).toBe(0)
    expect(await creditsOf(a.dataSource, id)).toHaveLength(0)
  })

  it('a failed report on a completed recharge gets 409 and keeps it completed', async () => {
    // R15: red when a closed recharge replays any failure: the completed one answers 200.
    await report(charged())
    const late = await report(failed())

    expect(late.status).toBe(HttpStatus.CONFLICT)
    expect((await stored()).status).toBe(PaymentStatus.COMPLETED)
  })

  it('CA2: a report naming another brand is refused with 404 and credits nothing', async () => {
    // R15: red when the brand comparison goes: the other brand's report credits the recharge.
    const res = await report(charged({ brandId: OTHER_BRAND }))

    expect(res.status).toBe(HttpStatus.NOT_FOUND)
    expect(res.body.code).toBe('RECHARGE_NOT_FOUND')
    expect((await stored()).status).toBe(PaymentStatus.PENDING)
    expect(Number((await tokenWalletOf(a.dataSource, RECHARGE_BRAND)).balance)).toBe(0)
  })

  it('a report on a recharge Payments did not create gets 404', async () => {
    // R15: red when findRecharge drops its 404 guard: reading a missing payment answers 500.
    const res = await postResult(recharge, 'c1750000-0000-4000-8000-000000000404', charged())

    expect(res.status).toBe(HttpStatus.NOT_FOUND)
    expect(res.body.code).toBe('RECHARGE_NOT_FOUND')
  })

  it('a report for another amount gets 422 and leaves the recharge pending', async () => {
    // R15: red when the amount comparison goes: the recharge is credited for another charge.
    const res = await report(charged({ amount: amount + 1 }))

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('RECHARGE_AMOUNT_MISMATCH')
    expect((await stored()).status).toBe(PaymentStatus.PENDING)
    expect(await creditsOf(a.dataSource, id)).toHaveLength(0)
  })

  it('CA2: the charged tokens sit in the dropi origin, with their audit', async () => {
    // R15: red when the credit uses another origin: dropi stays 0 and purchased holds 10.
    await report(charged())

    const wallet = await tokenWalletOf(a.dataSource, RECHARGE_BRAND)
    expect(Number(wallet.dropiTokens)).toBe(10)
    expect([Number(wallet.giftTokens), Number(wallet.purchasedTokens)]).toEqual([0, 0])
    const [credit] = await creditsOf(a.dataSource, id)
    expect(credit.tokenOrigin).toBe(TokenOrigin.DROPI)
    const [audit] = await auditOf(a.dataSource, id)
    expect(audit.action).toBe('dropi_recharge_charged')
    expect(audit.userId).toBe('roax-ads')
    expect(audit.changes).toMatchObject({ tokens: 10, transactionId: credit.id })
  })

  it('a charged report on a closed token wallet gets 422 and leaves it pending', async () => {
    // R15: red when a closed token wallet takes the credit: the recharge ends completed.
    await a.dataSource.query(`UPDATE wallets SET status = 'closed' WHERE "brandId" = $1`, [
      RECHARGE_BRAND,
    ])

    const res = await report(charged())

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('WALLET_CLOSED')
    expect((await stored()).status).toBe(PaymentStatus.PENDING)
    expect(await auditOf(a.dataSource, id)).toHaveLength(0)
  })

  it('without the ROAX Ads credential the result gets 401 and changes nothing', async () => {
    // R15: red when the route drops the guard: the anonymous report closes the recharge.
    const res = await request(recharge.app.getHttpServer())
      .post(`/recharge/dropi/${id}/result`)
      .send(charged())

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED)
    expect((await stored()).status).toBe(PaymentStatus.PENDING)
  })

  it.each([
    ['an exponential amount', { amount: 1e-7 }],
    ['a string amount', { amount: '10' }],
    ['a null amount', { amount: null }],
    ['the column maximum as amount', { amount: 9999999999999.99 }],
    ['a null status', { status: null }],
    ['an unknown status', { status: 'refunded' }],
    ['a charge with no operation id', { dropiOperationId: undefined }],
    ['a numeric operation id', { dropiOperationId: 123 }],
    ['a brandId that is not a UUID', { brandId: 'brand-1' }],
  ])('%s is refused with 400 and changes nothing', async (_name, overrides) => {
    // R15: red when the DTO loses that rule: the report reaches the service and is not a 400.
    const res = await report(charged(overrides))

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect((await stored()).status).toBe(PaymentStatus.PENDING)
  })
})
