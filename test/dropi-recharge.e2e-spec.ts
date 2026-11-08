/**
 * Creating a recharge from Dropi over HTTP against PostgreSQL (LOC-174): who may create it, what it
 * prices, and that every refusal leaves no payment behind.
 */
import { HttpStatus } from '@nestjs/common'
import { config as dotenvConfig } from 'dotenv'

import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { RequestException } from '../src/shared/exception/request.exception'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import {
  ACCESS_SERVER,
  ADS_KEY,
  cleanBillingProfile,
  forgetCachedTrm,
  JWT_SECRET,
  MEMBER_ID,
  postRecharge,
  RechargeApp,
  rechargesOf,
  startRechargeApp,
} from './support/dropi-recharge.fixture'
import {
  startTrmSource,
  TRM_DAY,
  TRM_ROW,
  trmDayPlus,
  trmDown,
  trmOk,
  trmRow,
  TrmSource,
} from './support/trm-source.fixture'
import {
  cleanBrand,
  RaceInstance,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const RECHARGE_BRAND = 'a1740000-0000-4000-8000-0000000000e2'
const REQUEST_ID = 'b1740000-0000-4000-8000-000000000001'

describe('Recharge from Dropi is created pending (PostgreSQL, LOC-174)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let trm: TrmSource
  let recharge: RechargeApp
  let member = ''

  const body = (overrides: object = {}) => ({
    brandId: RECHARGE_BRAND,
    tokens: 10,
    requestId: REQUEST_ID,
    ...overrides,
  })
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
  })

  afterEach(() => jest.clearAllMocks())

  afterAll(async () => {
    await clean()
    await recharge?.app.close()
    await trm?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it('creates 10 tokens of a Colombian brand at TRM 4,000 as 47,600 pesos pending, no bonus', async () => {
    // R15: red when the price drops the (1 + VAT) factor: it sees 40,000 instead of 47,600.
    const res = await postRecharge(recharge, body(), member)

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body.data).toMatchObject({
      status: PaymentStatus.PENDING,
      tokens: 10,
      bonusTokens: 0,
      amount: 47_600,
      currency: 'COP',
      exchangeRate: 4000,
      exchangeRateDate: TRM_ROW.vigenciadesde.slice(0, 10),
      taxRate: 0.19,
    })
    const [row] = await rechargesOf(a.dataSource, RECHARGE_BRAND)
    expect(row).toMatchObject({
      provider: PaymentProvider.DROPI_WALLET,
      purpose: PaymentPurpose.TOKEN_RECHARGE,
      status: PaymentStatus.PENDING,
      userId: MEMBER_ID,
    })
    expect(Number(row.amount)).toBe(47_600)
    expect(row.metadata).toMatchObject({ subtotal: 40_000, taxAmount: 7_600 })
    expect(row.metadata.dropiRecharge).toEqual({ tokens: 10, tokenPriceUsd: 1, bonusTokens: 0 })
    const credits = await a.dataSource.getRepository(Transaction).count({
      where: { walletId: row.walletId },
    })
    expect(credits).toBe(0)
  })

  it('rounds the pesos at TRM 4,000.37 up to the whole peso', async () => {
    // R15: red when the ceiling becomes a rounding: 1 token, 4,760.44 pesos, sees 4,760.
    trm.reply = () => ({ status: 200, body: [{ ...TRM_ROW, valor: '4000.37' }] })

    const res = await postRecharge(recharge, body({ tokens: 10.5 }), member)
    const one = await postRecharge(
      recharge,
      body({ tokens: 1, requestId: 'b1740000-0000-4000-8000-000000000003' }),
      member,
    )

    expect([res.status, one.status]).toEqual([HttpStatus.CREATED, HttpStatus.CREATED])
    expect(res.body.data.amount).toBe(49_985)
    expect(res.body.data.exchangeRate).toBe(4000.37)
    expect(one.body.data.amount).toBe(4_761)
  })

  it('charges 375 tokens at TRM 4,113.60 as 1,835,694 pesos, not one more', async () => {
    // R15: red when the price goes back to a float product: it gets 1,835,695.
    trm.reply = () => ({ status: 200, body: [{ ...TRM_ROW, valor: '4113.60' }] })

    const res = await postRecharge(recharge, body({ tokens: 375 }), member)

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body.data.amount).toBe(1_835_694)
    const [row] = await rechargesOf(a.dataSource, RECHARGE_BRAND)
    expect(Number(row.amount)).toBe(1_835_694)
  })

  it('fixes 10.000000001 tokens as 10 and gives a retry with 10 the same recharge', async () => {
    // R15: red when create keeps the raw tokens: it stores 10.000000001 and the retry gets 409.
    const first = await postRecharge(recharge, body({ tokens: 10.000000001 }), member)
    const retry = await postRecharge(recharge, body({ tokens: 10 }), member)

    expect([first.status, retry.status]).toEqual([HttpStatus.CREATED, HttpStatus.OK])
    expect(first.body.data).toMatchObject({ tokens: 10, amount: 47_600 })
    expect(retry.body.data.id).toBe(first.body.data.id)
    const rows = await rechargesOf(a.dataSource, RECHARGE_BRAND)
    expect(rows).toHaveLength(1)
    expect(rows[0].metadata.dropiRecharge.tokens).toBe(10)
  })

  it('refuses with 403 a user who is not a member of the brand and saves nothing', async () => {
    // R15: red when the controller stops asking platform: the outsider gets 201.
    const outsider = recharge.jwt.sign({ id: 'outsider-loc174', isSuperAdmin: false, brand: null })

    const res = await postRecharge(recharge, body(), outsider)

    expect(res.status).toBe(HttpStatus.FORBIDDEN)
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('refuses with 403 a super admin who is not a member of the brand and saves nothing', async () => {
    // R15: red when membership goes back to assertBrandAccess: the super admin skips it, 201.
    const superAdmin = recharge.jwt.sign({ id: 'super-loc174', isSuperAdmin: true, brand: null })

    const res = await postRecharge(recharge, body(), superAdmin)

    expect(res.status).toBe(HttpStatus.FORBIDDEN)
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('refuses with 401 the ROAX Ads credential without a user token and saves nothing', async () => {
    // R15: red when the guard stops requiring the user token: the call gets 500, not 401.
    const res = await postRecharge(recharge, body(), null)

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED)
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('refuses with 401 the server token or a service key passed as the user token', async () => {
    // R15: red when the user header is resolved like Authorization: the server token is a caller.
    const asServer = await postRecharge(recharge, body(), ACCESS_SERVER)
    const asService = await postRecharge(recharge, body(), ADS_KEY)

    expect([asServer.status, asService.status]).toEqual([401, 401])
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('answers 503 with no TRM and saves nothing', async () => {
    // R15: red when a fallback rate prices the recharge: it gets 201.
    trm.reply = trmDown

    const res = await postRecharge(recharge, body(), member)

    expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(res.body.code).toBe('EXCHANGE_RATE_UNAVAILABLE')
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it("prices with today's TRM when the source's first row is in force from tomorrow", async () => {
    // R15: red when the TRM takes the first row again: the recharge is priced at 4,500.
    trm.reply = () => ({
      status: 200,
      body: [trmRow('4500.00', trmDayPlus(1), trmDayPlus(2)), TRM_ROW],
    })

    const res = await postRecharge(recharge, body(), member)

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body.data).toMatchObject({ exchangeRate: 4000, exchangeRateDate: TRM_DAY })
    const [row] = await rechargesOf(a.dataSource, RECHARGE_BRAND)
    expect([Number(row.exchangeRate), row.exchangeRateDate]).toEqual([4000, TRM_DAY])
  })

  it('answers 503 and saves nothing when the only row is in force from tomorrow', async () => {
    // R15: red when the TRM takes the first row again: tomorrow's rate prices it, 201.
    trm.reply = () => ({ status: 200, body: [trmRow('4500.00', trmDayPlus(1), trmDayPlus(2))] })

    const res = await postRecharge(recharge, body(), member)

    expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(res.body.code).toBe('EXCHANGE_RATE_UNAVAILABLE')
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('answers 503 and saves nothing when the source sends a rate of 1e10', async () => {
    // R15: red when the credible range goes: the save overflows decimal(12,2) and the call gets 500.
    trm.reply = () => ({ status: 200, body: [{ ...TRM_ROW, valor: '1e10' }] })

    const res = await postRecharge(recharge, body(), member)

    expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(res.body.code).toBe('EXCHANGE_RATE_UNAVAILABLE')
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('answers 503 when the brand membership cannot be looked up and saves nothing', async () => {
    // R15: red when a lookup failure counts as membership: it gets 201.
    recharge.platform.canViewBrandCredit.mockRejectedValueOnce(
      new RequestException({ code: 'BRAND_LOOKUP_UNAVAILABLE' }, HttpStatus.SERVICE_UNAVAILABLE),
    )

    const res = await postRecharge(recharge, body(), member)

    expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('answers 422 when the VAT cannot be read and saves nothing', async () => {
    // R15: red when the tax read loses its catch: the call gets 500.
    recharge.tax.getTaxForCountry.mockRejectedValueOnce(new Error('tax_config unreachable'))

    const res = await postRecharge(recharge, body(), member)

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('TAX_RATE_UNAVAILABLE')
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('answers 422 for a brand billed outside Colombia and saves nothing', async () => {
    // R15: red when the country check goes: a Mexican brand is priced in pesos, 201.
    await a.dataSource.query(
      `INSERT INTO billing_profiles ("brandId", "legalName", "taxId", "taxIdType", country, email)
       VALUES ($1, 'Marca MX', 'XAXX010101000', 'RFC', 'MX', 'mx@example.com')`,
      [RECHARGE_BRAND],
    )

    const res = await postRecharge(recharge, body(), member)

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('DROPI_RECHARGE_COUNTRY_UNSUPPORTED')
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('answers 422 when the brand token wallet is closed and saves no payment', async () => {
    // R15: red when the wallet status check goes: the recharge points at a closed wallet, 201.
    await a.dataSource.query(
      `INSERT INTO wallets ("brandId", "userId", provider, currency, balance, status)
       VALUES ($1, $2, 'internal', 'TKN', 0, 'closed')`,
      [RECHARGE_BRAND, MEMBER_ID],
    )

    const res = await postRecharge(recharge, body(), member)

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('WALLET_CLOSED')
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it.each([
    ['the exponential form 1e-7', 1e-7],
    ['a string', '10'],
    ['null', null],
    ['more than two decimals', 10.123],
    ['zero', 0],
    ['above the maximum', 1_000_000.01],
    ['the maximum of payments.amount', 9_999_999_999_999.99],
  ])('refuses tokens as %s with 400 and saves nothing', async (_label, tokens) => {
    // R15: red when the DTO loses its rule for this value: the call gets 201 or 500.
    const res = await postRecharge(recharge, body({ tokens }), member)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })

  it('refuses with 400 a bonus the body tries to set', async () => {
    // R15: red when the pipe stops forbidding unknown fields: the bonus is ignored and it gets 201.
    const res = await postRecharge(recharge, body({ bonusTokens: 5 }), member)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(await rechargesOf(a.dataSource, RECHARGE_BRAND)).toHaveLength(0)
  })
})
