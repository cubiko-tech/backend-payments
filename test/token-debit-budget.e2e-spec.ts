/**
 * The 5 s budget of a ROAX Ads debit against PostgreSQL (LOC-187): auth that stalls after its
 * headers, a full connection pool before and inside the debit, and a transaction slow in every
 * statement. Each gives up in time and applies nothing.
 */
import { HttpStatus } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { config as dotenvConfig } from 'dotenv'

import { applyLimits, isLimitHit } from '../src/wallet/movement-limits'
import { ACCESS_SERVER, JWT_SECRET } from './support/dropi-recharge.fixture'
import {
  checkedOut,
  DEBIT_MEMBER_ID,
  DebitApp,
  holdPool,
  movementsOf,
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

const BRAND = 'a1870000-0000-4000-8000-0000000000f1'
const BUDGET_MS = 5000
// Keys are unique across the whole table, so each suite running at once has its own.
const DEBIT_KEY = 'loc187-budget-suite-1'

describe('A ROAX Ads debit answers within its 5 s budget (PostgreSQL, LOC-187)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let platform: Upstream
  let auth: Upstream
  let debits: DebitApp
  let member = ''
  const authRefuses: Upstream['reply'] = (_path, res) => res.writeHead(401).end()

  const body = () => ({ brandId: BRAND, tokens: 8, idempotencyKey: DEBIT_KEY })
  const seed = () => seedTokenWallet(a.dataSource, BRAND, { gift: 4, purchased: 6, dropi: 5 })
  /** Runs `call` and gives back its answer with how long it took. */
  const timed = async <T>(call: () => Promise<T>) => {
    const started = Date.now()
    const answer = await call()
    return { answer, elapsed: Date.now() - started }
  }

  beforeAll(async () => {
    platform = await startUpstream(platformMembers([BRAND]))
    auth = await startUpstream(authRefuses)
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
    auth.reply = authRefuses
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND)
    await debits?.app.close()
    await platform?.close()
    await auth?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it('answers 503 within 5 s when auth sends its headers and never the body', async () => {
    // R15: red when the body read loses its abort branch: the stalled read answers 401.
    const wallet = await seed()
    auth.reply = (_path, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.flushHeaders()
    }
    const clientToken = new JwtService({ secret: 'another-client-secret' }).sign({
      id: DEBIT_MEMBER_ID,
      client: 'roax-ads-front',
    })

    const { answer, elapsed } = await timed(() => postDebit(debits, body(), clientToken))

    expect(answer.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(answer.body.code).toBe('AUTH_UNAVAILABLE')
    expect(elapsed).toBeLessThan(BUDGET_MS)
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(0)
    expect(await walletState(a.dataSource, wallet.id)).toMatchObject({ balance: 15, gift: 4 })
  }, 20_000)

  it('answers 503 within 5 s when the pool is full before the wallet lookup, then debits once', async () => {
    // R15: red when the lookup loses its deadline: it waits for the pool and gets 201 late.
    const wallet = await seed()
    const release = await holdPool(a.dataSource)
    const releaseLater = setTimeout(() => void release(), BUDGET_MS + 1000)

    const { answer, elapsed } = await timed(() => postDebit(debits, body(), member))
    clearTimeout(releaseLater)
    await release()
    const retry = await postDebit(debits, body(), member)

    expect(answer.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(answer.body.code).toBe('WALLET_BUSY')
    expect(elapsed).toBeLessThan(BUDGET_MS)
    expect(retry.status).toBe(HttpStatus.CREATED)
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(1)
    expect(await walletState(a.dataSource, wallet.id)).toMatchObject({ balance: 7, purchased: 2 })
  }, 20_000)

  it('answers 503 within 5 s when the pool fills after the lookup, and hands the late connection back', async () => {
    // R15: red when connect loses its deadline (201 late) or the late connection is kept (1 held).
    const wallet = await seed()
    const lookup = debits.tokens.findTokenWalletId.bind(debits.tokens)
    let release: () => Promise<void> = async () => undefined
    // R17: filling the pool between the lookup and the connect is the only way to make connect wait.
    jest.spyOn(debits.tokens, 'findTokenWalletId').mockImplementationOnce(async (brandId) => {
      const walletId = await lookup(brandId)
      release = await holdPool(a.dataSource)
      return walletId
    })
    const releaseLater = setTimeout(() => void release(), BUDGET_MS + 1000)

    const { answer, elapsed } = await timed(() => postDebit(debits, body(), member))
    clearTimeout(releaseLater)
    await release()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const leftOver = checkedOut(a.dataSource)
    const retry = await postDebit(debits, body(), member)

    expect(answer.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(answer.body.code).toBe('WALLET_BUSY')
    expect(elapsed).toBeLessThan(BUDGET_MS)
    expect(leftOver).toBe(0)
    expect(retry.status).toBe(HttpStatus.CREATED)
    expect(await movementsOf(a.dataSource, wallet.id)).toHaveLength(1)
  }, 20_000)

  it('caps the whole transaction, not each statement: four sleeps of 100 ms pass a 300 ms cap', async () => {
    // R15: red when applyLimits goes back to a per-statement timeout: all four sleeps pass.
    const queryRunner = a.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()
    let failure: unknown = null
    try {
      await applyLimits(queryRunner, { connectTimeoutMs: 500, transactionTimeoutMs: 300 })
      for (let sleep = 0; sleep < 4; sleep++) await queryRunner.query('SELECT pg_sleep(0.1)')
    } catch (error) {
      failure = error
    } finally {
      await queryRunner.rollbackTransaction().catch(() => undefined)
      await queryRunner.release()
    }

    expect(failure).not.toBeNull()
    expect(isLimitHit(failure)).toBe(true)
  })
})
