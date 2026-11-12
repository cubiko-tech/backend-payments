/**
 * ROAX Ads debits a brand token wallet over HTTP against PostgreSQL (LOC-187): who may debit, the
 * spend order and its split, the key, and the 5 s budget when auth, platform or the row stall.
 */
import { HttpStatus } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { config as dotenvConfig } from 'dotenv'

import { WalletStatus } from '../src/wallet/entities/wallet.entity'
import { ACCESS_SERVER, JWT_SECRET } from './support/dropi-recharge.fixture'
import {
  DEBIT_MEMBER_ID,
  DebitApp,
  holdWalletRow,
  movementsOf,
  OTHER_SERVICE_KEY,
  platformMembers,
  postDebit,
  seedTokenWallet,
  startDebitApp,
  startUpstream,
  Upstream,
  walletState,
} from './support/token-debit.fixture'
import {
  cleanBrand,
  RaceInstance,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'a1870000-0000-4000-8000-0000000000d1'
const NO_WALLET_BRAND = 'a1870000-0000-4000-8000-0000000000d2'
const BUDGET_MS = 5000
// Keys are unique across the whole table, so each suite running at once has its own.
const DEBIT_KEY = 'loc187-debit-suite-1'

describe('ROAX Ads debits a brand token wallet (PostgreSQL, LOC-187)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let platform: Upstream
  let auth: Upstream
  let debits: DebitApp
  let member = ''

  const body = (overrides: object = {}) => ({
    brandId: BRAND,
    tokens: 8,
    idempotencyKey: DEBIT_KEY,
    ...overrides,
  })
  const seed = (gift: number, purchased: number, dropi: number, status = WalletStatus.ACTIVE) =>
    seedTokenWallet(a.dataSource, BRAND, { gift, purchased, dropi }, status)

  beforeAll(async () => {
    platform = await startUpstream(platformMembers([BRAND, NO_WALLET_BRAND]))
    auth = await startUpstream((_path, res) => res.writeHead(401).end())
    Object.assign(process.env, {
      JWT_SECRET,
      ACCESS_SERVER,
      SERVICE_PLATFORM: platform.url,
      SERVICE_AUTH: auth.url,
    })
    a = await startInstance()
    debits = await startDebitApp(a.dataSource)
    member = debits.jwt.sign({ id: DEBIT_MEMBER_ID, isSuperAdmin: false, brand: BRAND })
  })

  beforeEach(async () => {
    await cleanBrand(a.dataSource, BRAND)
    await cleanBrand(a.dataSource, NO_WALLET_BRAND)
    platform.mode = 'ok'
    auth.mode = 'ok'
  })

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND)
    await cleanBrand(a.dataSource, NO_WALLET_BRAND)
    await debits?.app.close()
    await platform?.close()
    await auth?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it('debits 8 of gift 4, purchased 6, Dropi 5 as gift 4 and purchased 4', async () => {
    // R15: red when Dropi goes before purchased or purchased before gift: the split differs.
    const wallet = await seed(4, 6, 5)

    const res = await postDebit(debits, body(), member)

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body.data.debit).toMatchObject({
      tokens: 8,
      tokenSplit: { gift: 4, purchased: 4, dropi: 0 },
      replayed: false,
    })
    expect(await walletState(a.dataSource, wallet.id)).toEqual({
      balance: 7,
      gift: 0,
      purchased: 2,
      dropi: 5,
    })
    const [movement] = await movementsOf(a.dataSource, wallet.id)
    expect(movement).toMatchObject({
      type: 'debit',
      referenceType: 'token_debit',
      idempotencyKey: `roax-ads:debit:${DEBIT_KEY}`,
    })
    expect(movement.metadata).toMatchObject({ serviceClient: 'roax-ads', userId: DEBIT_MEMBER_ID })
  })

  it('spends gift, then purchased, then Dropi tokens without inDropi', async () => {
    // R15: red when Dropi tokens are spent only with inDropi again: 3 of gift 1 and Dropi 5 gets 422.
    const wallet = await seed(1, 0, 5)

    const res = await postDebit(debits, body({ tokens: 3 }), member)

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body.data.debit.tokenSplit).toEqual({ gift: 1, purchased: 0, dropi: 2 })
    expect(await walletState(a.dataSource, wallet.id)).toMatchObject({ gift: 0, dropi: 3 })
  })

  it('gives a retry with the same key and tokens the same debit and moves nothing more', async () => {
    // R15: red when the stored key stops deriving from the sent one alone: the retry debits 8 more.
    const wallet = await seed(4, 6, 5)
    const first = await postDebit(debits, body(), member)

    const retry = await postDebit(debits, body(), member)

    expect([first.status, retry.status]).toEqual([HttpStatus.CREATED, HttpStatus.OK])
    expect(retry.body.data.debit).toMatchObject({ id: first.body.data.debit.id, replayed: true })
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(1)
    expect(await walletState(a.dataSource, wallet.id)).toMatchObject({ balance: 7, purchased: 2 })
  })

  it('refuses with 409 the same key with other tokens and moves nothing', async () => {
    // R15: red when the replay ignores the amount: the second call gets 200 with the 8 debit.
    const wallet = await seed(4, 6, 5)
    await postDebit(debits, body(), member)

    const res = await postDebit(debits, body({ tokens: 2 }), member)

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(1)
    expect(await walletState(a.dataSource, wallet.id)).toMatchObject({ balance: 7 })
  })

  it('applies two debits with the same key sent at once only once', async () => {
    // R15: red without the replay in the lock and with replayAfterConflict as 409: one gets 409.
    const wallet = await seed(10, 10, 0)

    const both = await Promise.all([
      postDebit(debits, body(), member),
      postDebit(debits, body(), member),
    ])

    expect(both.map((r) => r.status).sort()).toEqual([HttpStatus.OK, HttpStatus.CREATED])
    expect(both[0].body.data.debit.id).toBe(both[1].body.data.debit.id)
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(1)
    expect(await walletState(a.dataSource, wallet.id)).toMatchObject({ balance: 12 })
  })

  it('refuses 3 of gift 1 and Dropi 1 with 422 and moves nothing', async () => {
    // R15: red when a shortfall is tolerated: the debit takes the 2 there are and gets 201.
    const wallet = await seed(1, 0, 1)

    const res = await postDebit(debits, body({ tokens: 3 }), member)

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE')
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(0)
    expect(await walletState(a.dataSource, wallet.id)).toEqual({
      balance: 2,
      gift: 1,
      purchased: 0,
      dropi: 1,
    })
  })

  it('refuses with 422 a brand without a token wallet and does not create one', async () => {
    // R15: red when the route falls back to getOrCreate: an empty wallet is left behind.
    const res = await postDebit(debits, body({ brandId: NO_WALLET_BRAND }), member)

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE')
    expect(
      await a.dataSource.query('SELECT 1 FROM wallets WHERE "brandId" = $1', [NO_WALLET_BRAND]),
    ).toHaveLength(0)
  })

  it.each([WalletStatus.FROZEN, WalletStatus.CLOSED])(
    'refuses a %s wallet with 422 WALLET_NOT_ACTIVE and moves nothing',
    async (status) => {
      // R15: red when debitTokens stops requiring active: it gets 201.
      const wallet = await seed(4, 6, 5, status)

      const res = await postDebit(debits, body(), member)

      expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
      expect(res.body.code).toBe('WALLET_NOT_ACTIVE')
      expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(0)
    },
  )

  it('refuses with 403 the server token, a user alone and another service, and moves nothing', async () => {
    // R15: red when the class loses @RequireServiceClient(ROAX_ADS_CLIENT): one of them gets 201.
    const wallet = await seed(4, 6, 5)

    const asServer = await postDebit(debits, body(), member, ACCESS_SERVER)
    const asUser = await postDebit(debits, body(), null, member)
    const asOther = await postDebit(debits, body(), member, OTHER_SERVICE_KEY)

    expect([asServer.status, asUser.status, asOther.status]).toEqual([403, 403, 403])
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(0)
  })

  it('refuses with 401 ROAX Ads without a user token and moves nothing', async () => {
    // R15: red when the handler loses @RequireOnBehalfOfUser: the call gets 500, not 401.
    const wallet = await seed(4, 6, 5)

    const res = await postDebit(debits, body(), null)

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED)
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(0)
  })

  it('refuses with 403 a user who is not a member of the brand and moves nothing', async () => {
    // R15: red when the controller stops asking platform: the outsider gets 201.
    const wallet = await seed(4, 6, 5)
    const outsider = debits.jwt.sign({ id: 'outsider-loc187', isSuperAdmin: true, brand: BRAND })

    const res = await postDebit(debits, body(), outsider)

    expect(res.status).toBe(HttpStatus.FORBIDDEN)
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(0)
  })

  it('answers 503 within 5 s when platform accepts and never answers, and moves nothing', async () => {
    // R15: red when the route keeps the 10 s platform timeout: the answer takes 10 s.
    const wallet = await seed(4, 6, 5)
    platform.mode = 'hang'

    const started = Date.now()
    const res = await postDebit(debits, body(), member)

    expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(res.body.code).toBe('BRAND_LOOKUP_UNAVAILABLE')
    expect(Date.now() - started).toBeLessThan(BUDGET_MS)
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(0)
  }, 20_000)

  it('answers 503 within 5 s when auth never answers for a client token, and moves nothing', async () => {
    // R15: red when the guard ignores UpstreamTimeout: it waits 10 s and answers 401.
    const wallet = await seed(4, 6, 5)
    auth.mode = 'hang'
    const clientToken = new JwtService({ secret: 'another-client-secret' }).sign({
      id: DEBIT_MEMBER_ID,
      client: 'roax-ads-front',
    })

    const started = Date.now()
    const res = await postDebit(debits, body(), clientToken)

    expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(res.body.code).toBe('AUTH_UNAVAILABLE')
    expect(Date.now() - started).toBeLessThan(BUDGET_MS)
    expect(auth.hits).toContain('/client/validate-token')
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(0)
  }, 20_000)

  it('answers 503 within 5 s while another transaction holds the row, then the retry debits once', async () => {
    // R15: red when move stops setting the limits: the debit waits for the row and gets 201 late.
    const wallet = await seed(4, 6, 5)
    const release = await holdWalletRow(a.dataSource, wallet.id)
    const releaseLater = setTimeout(() => void release(), BUDGET_MS + 1000)

    const started = Date.now()
    const held = await postDebit(debits, body(), member)
    const elapsed = Date.now() - started
    clearTimeout(releaseLater)
    await release()
    const retry = await postDebit(debits, body(), member)

    expect(held.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(held.body.code).toBe('WALLET_BUSY')
    expect(elapsed).toBeLessThan(BUDGET_MS)
    expect(retry.status).toBe(HttpStatus.CREATED)
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(1)
    expect(await walletState(a.dataSource, wallet.id)).toMatchObject({ balance: 7, purchased: 2 })
  }, 20_000)

  it.each([
    ['tokens as the exponential form 1e-7', { tokens: 1e-7 }],
    ['tokens as a string', { tokens: '8' }],
    ['tokens as null', { tokens: null }],
    ['tokens as zero', { tokens: 0 }],
    ['tokens above the maximum', { tokens: 1_000_000.01 }],
    ['tokens as the maximum of transactions.amount', { tokens: 9_999_999_999_999.99 }],
    ['a key with the separator', { idempotencyKey: 'gen:1' }],
    ['inDropi as a string', { inDropi: 'true' }],
  ])('refuses %s with 400 and moves nothing', async (_label, overrides) => {
    // R15: red when the DTO loses its rule for this value: the call gets 201 or 500.
    const wallet = await seed(4, 6, 5)

    const res = await postDebit(debits, body(overrides), member)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(0)
  })
})
