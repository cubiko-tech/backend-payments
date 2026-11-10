import { config as dotenvConfig } from 'dotenv'
import { DataSource, QueryRunner } from 'typeorm'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { TokenOrigin } from '../src/wallet/token-origin'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { AddTokenWalletOrigins1793949572497 } from '../migrations/1793949572497-AddTokenWalletOrigins'
import { databaseExists, withDisposableDatabase } from './support/disposable-database.fixture'
import { raceConnectionOptions, someoneWaitsOnRowLock } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND_A = 'a1320000-0000-4000-8000-0000000000e2'
// Creating and dropping its own database can outlast jest's default 5 s under the parallel suite.
const MIGRATION_CASE_TIMEOUT_MS = 30_000

interface Instance {
  dataSource: DataSource
  tokens: TokenWalletService
}

/** One service instance: its own connection pool, sharing only PostgreSQL. */
async function startInstance(): Promise<Instance> {
  const dataSource = new DataSource({ ...raceConnectionOptions(), entities: [Wallet, Transaction] })
  await dataSource.initialize()
  return {
    dataSource,
    tokens: new TokenWalletService(dataSource.getRepository(Wallet), dataSource),
  }
}

async function hasColumn(db: DataSource | QueryRunner, table: string, column: string) {
  const rows = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  )
  return rows.length > 0
}

const hasTokenColumns = (db: DataSource | QueryRunner) => hasColumn(db, 'wallets', 'giftTokens')

describe('Token wallet of a brand on PostgreSQL (CA1, LOC-132)', () => {
  let a: Instance
  let b: Instance

  const walletRows = () =>
    a.dataSource.getRepository(Wallet).findBy({ brandId: BRAND_A, currency: 'TKN' })
  const stored = async (id: string) => (await a.dataSource.getRepository(Wallet).findOneBy({ id }))!
  const debitsOf = (walletId: string) =>
    a.dataSource.getRepository(Transaction).findBy({ walletId, type: TransactionType.DEBIT })
  const creditOf = (walletId: string, amount: number, origin: TokenOrigin, key?: string) =>
    a.tokens.creditTokens(walletId, amount, origin, { brandId: BRAND_A }, key)
  const clean = async () => {
    await a.dataSource.query('DELETE FROM transactions WHERE "brandId" = $1', [BRAND_A])
    await a.dataSource.query('DELETE FROM wallets WHERE "brandId" = $1', [BRAND_A])
  }

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
    if (!(await hasTokenColumns(a.dataSource))) {
      const runner = a.dataSource.createQueryRunner()
      try {
        await new AddTokenWalletOrigins1793949572497().up(runner)
      } finally {
        await runner.release()
      }
    }
  })

  beforeEach(clean)

  afterAll(async () => {
    await clean()
    await a.dataSource.destroy()
    await b.dataSource.destroy()
  })

  it('E1 two simultaneous requests from two instances get one wallet with the same id and 0', async () => {
    // R15: red when getOrCreate reads and then inserts: the second insert fails with 23505.
    const [first, second] = await Promise.all([
      a.tokens.getOrCreate(BRAND_A, 'user-1'),
      b.tokens.getOrCreate(BRAND_A, 'user-2'),
    ])

    expect(first.id).toBe(second.id)
    expect(first.balance).toBe(0)
    expect(await walletRows()).toHaveLength(1)
  })

  it('E1 a request landing while another one is inserting returns that wallet, not a 500', async () => {
    // R15: red when getOrCreate reads and then inserts: its insert waits, then fails with 23505.
    const other = b.dataSource.createQueryRunner()
    await other.connect()
    await other.startTransaction()
    try {
      const [{ id: heldId }] = await other.query(
        `INSERT INTO wallets ("brandId", "userId", provider, currency, balance, status)
         VALUES ($1, 'other-request', 'internal', 'TKN', 0, 'active') RETURNING id`,
        [BRAND_A],
      )
      const pending = a.tokens.getOrCreate(BRAND_A, 'user-1')
      expect(await someoneWaitsOnRowLock(a.dataSource)).toBe(true)
      await other.commitTransaction()

      const view = await pending
      expect(view.id).toBe(heldId)
      expect(await walletRows()).toHaveLength(1)
    } finally {
      if (other.isTransactionActive) await other.rollbackTransaction()
      await other.release()
    }
  })

  it('CA1 with 5 gift and 10 purchased, a debit of 5 leaves gift 0 and purchased 10', async () => {
    // R15: red when purchased is spent before gift: the wallet ends with gift 5 and purchased 5.
    const wallet = await a.tokens.getOrCreate(BRAND_A, 'user-1')
    await creditOf(wallet.id, 5, TokenOrigin.GIFT)
    await creditOf(wallet.id, 10, TokenOrigin.PURCHASED)

    const result = await a.tokens.debitTokens(wallet.id, 5, { brandId: BRAND_A })

    expect(result.wallet.byOrigin).toEqual({ gift: 0, purchased: 10, dropi: 0 })
    const row = await stored(wallet.id)
    expect([Number(row.giftTokens), Number(row.purchasedTokens), Number(row.balance)]).toEqual([
      0, 10, 10,
    ])
  })

  it('CA1 with 3 Dropi and 2 gift, a debit of 4 outside Dropi is refused and Dropi stays at 3', async () => {
    // R15: red when Dropi tokens are spendable outside Dropi: the debit of 4 is applied.
    const wallet = await a.tokens.getOrCreate(BRAND_A, 'user-1')
    await creditOf(wallet.id, 3, TokenOrigin.DROPI)
    await creditOf(wallet.id, 2, TokenOrigin.GIFT)

    await expect(a.tokens.debitTokens(wallet.id, 4, { brandId: BRAND_A })).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_BALANCE' },
    })

    const row = await stored(wallet.id)
    expect([Number(row.dropiTokens), Number(row.giftTokens), Number(row.balance)]).toEqual([
      3, 2, 5,
    ])
    expect(await debitsOf(wallet.id)).toHaveLength(0)
  })

  it('a token credit stores its origin, and the view adds the balance up by origin', async () => {
    // R15: red when the credit transaction is saved without its tokenOrigin.
    const wallet = await a.tokens.getOrCreate(BRAND_A, 'user-1')

    const { transaction } = await creditOf(wallet.id, 4, TokenOrigin.PURCHASED)
    const view = await b.tokens.getOrCreate(BRAND_A, 'user-2')

    expect(transaction.tokenOrigin).toBe(TokenOrigin.PURCHASED)
    expect(view).toMatchObject({ balance: 4, unassigned: 0 })
    expect(view.byOrigin).toEqual({ gift: 0, purchased: 4, dropi: 0 })
  })

  it('E2 the same credit key sent twice at once credits once', async () => {
    // R15: red when the movement is saved without its idempotency key: two credits are saved.
    const wallet = await a.tokens.getOrCreate(BRAND_A, 'user-1')

    const [first, second] = await Promise.all([
      a.tokens.creditTokens(wallet.id, 7, TokenOrigin.GIFT, { brandId: BRAND_A }, 'loc132-k1'),
      b.tokens.creditTokens(wallet.id, 7, TokenOrigin.GIFT, { brandId: BRAND_A }, 'loc132-k1'),
    ])

    expect(first.transaction.id).toBe(second.transaction.id)
    expect([first.replayed, second.replayed].sort()).toEqual([false, true])
    expect(Number((await stored(wallet.id)).balance)).toBe(7)
  })

  it('E2 a credit whose key another wallet commits while it writes is refused with 409', async () => {
    // R15: red when a unique-key conflict is not answered: the raw 23505 QueryFailedError comes out.
    const wallet = await a.tokens.getOrCreate(BRAND_A, 'user-1')
    const [{ id: moneyWalletId }] = await a.dataSource.query(
      `INSERT INTO wallets ("brandId", "userId", provider, currency, balance, status)
       VALUES ($1, 'u', 'internal', 'COP', 0, 'active') RETURNING id`,
      [BRAND_A],
    )
    const other = b.dataSource.createQueryRunner()
    await other.connect()
    await other.startTransaction()
    try {
      await other.query(
        `INSERT INTO transactions ("walletId", "brandId", type, amount, "balanceBefore",
           "balanceAfter", status, "idempotencyKey")
         VALUES ($1, $2, 'credit', 7, 0, 7, 'completed', 'loc132-k3')`,
        [moneyWalletId, BRAND_A],
      )
      const pending = a.tokens
        .creditTokens(wallet.id, 7, TokenOrigin.GIFT, { brandId: BRAND_A }, 'loc132-k3')
        .then(
          () => 'applied',
          (error) => error?.response?.code ?? error?.name,
        )
      expect(await someoneWaitsOnRowLock(a.dataSource)).toBe(true)
      await other.commitTransaction()

      expect(await pending).toBe('IDEMPOTENCY_KEY_CONFLICT')
      expect(Number((await stored(wallet.id)).giftTokens)).toBe(0)
    } finally {
      if (other.isTransactionActive) await other.rollbackTransaction()
      await other.release()
    }
  })

  it('E2 a debit reusing the key of a credit is refused with 409 and moves nothing', async () => {
    // R15: red when a key alone counts as done: the debit returns the credit and debits nothing.
    const wallet = await a.tokens.getOrCreate(BRAND_A, 'user-1')
    await creditOf(wallet.id, 7, TokenOrigin.GIFT, 'loc132-k2')

    await expect(
      a.tokens.debitTokens(wallet.id, 7, { brandId: BRAND_A }, {}, 'loc132-k2'),
    ).rejects.toMatchObject({ response: { code: 'IDEMPOTENCY_KEY_CONFLICT' } })
    expect(Number((await stored(wallet.id)).giftTokens)).toBe(7)
  })

  it('E3 a debit landing while another instance debits the same tokens is refused', async () => {
    // R15: red when the debit reads without the row lock: it spends the 6 already gone.
    const wallet = await a.tokens.getOrCreate(BRAND_A, 'user-1')
    await creditOf(wallet.id, 10, TokenOrigin.GIFT)
    const other = b.dataSource.createQueryRunner()
    await other.connect()
    await other.startTransaction()
    try {
      await other.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id])
      await other.query('UPDATE wallets SET "giftTokens" = 4, balance = 4 WHERE id = $1', [
        wallet.id,
      ])
      const pending = a.tokens.debitTokens(wallet.id, 6, { brandId: BRAND_A })
      const outcome = pending.then(
        () => 'applied',
        (error) => error?.response?.code,
      )
      expect(await someoneWaitsOnRowLock(b.dataSource)).toBe(true)
      await other.commitTransaction()

      expect(await outcome).toBe('INSUFFICIENT_BALANCE')
      expect(Number((await stored(wallet.id)).giftTokens)).toBe(4)
      expect(await debitsOf(wallet.id)).toHaveLength(0)
    } finally {
      if (other.isTransactionActive) await other.rollbackTransaction()
      await other.release()
    }
  })

  it('refuses a debit larger than the wallet balance even when the origins would cover it', async () => {
    // R15: red when the debit checks only the origins: it applies and the balance goes negative.
    const wallet = await a.tokens.getOrCreate(BRAND_A, 'user-1')
    await creditOf(wallet.id, 5, TokenOrigin.GIFT)
    await a.dataSource.query('UPDATE wallets SET balance = 2 WHERE id = $1', [wallet.id])

    await expect(a.tokens.debitTokens(wallet.id, 3, { brandId: BRAND_A })).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_BALANCE' },
    })
    expect(Number((await stored(wallet.id)).balance)).toBe(2)
  })

  it('a frozen wallet takes token credits and a closed one refuses them', async () => {
    // R15: red when a token credit skips the closed check: the closed wallet takes the credit.
    const wallet = await a.tokens.getOrCreate(BRAND_A, 'user-1')
    const setStatus = (status: WalletStatus) =>
      a.dataSource.getRepository(Wallet).update({ id: wallet.id }, { status })

    await setStatus(WalletStatus.FROZEN)
    await creditOf(wallet.id, 1, TokenOrigin.GIFT)
    await setStatus(WalletStatus.CLOSED)
    await expect(creditOf(wallet.id, 1, TokenOrigin.GIFT)).rejects.toMatchObject({
      response: { code: 'WALLET_CLOSED' },
    })

    expect(Number((await stored(wallet.id)).giftTokens)).toBe(1)
  })

  it(
    'the migration down drops the origin columns and up brings them back at 0, on its own database',
    async () => {
      // R15: red when the case runs on the shared runner: its database is POSTGRES_DB, not its own.
      // R15: red when down leaves giftTokens behind: the column is still there after it.
      const migration = new AddTokenWalletOrigins1793949572497()
      const used = await withDisposableDatabase(a.dataSource, async (runner, name) => {
        const [{ db }] = await runner.query('SELECT current_database() AS db')
        expect(db).toBe(name)
        await runner.query('CREATE TABLE wallets (id uuid PRIMARY KEY DEFAULT gen_random_uuid())')
        await runner.query(
          'CREATE TABLE transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid())',
        )
        await migration.up(runner)
        const [{ id }] = await runner.query('INSERT INTO wallets DEFAULT VALUES RETURNING id')

        await migration.down(runner)
        expect(await hasTokenColumns(runner)).toBe(false)
        expect(await hasColumn(a.dataSource, 'transactions', 'tokenOrigin')).toBe(true)
        await migration.up(runner)

        expect(await hasTokenColumns(runner)).toBe(true)
        const [row] = await runner.query(
          'SELECT "giftTokens", "purchasedTokens", "dropiTokens" FROM wallets WHERE id = $1',
          [id],
        )
        expect(row).toEqual({ giftTokens: '0.00', purchasedTokens: '0.00', dropiTokens: '0.00' })
      })

      expect(await databaseExists(a.dataSource, used)).toBe(false)
      expect(await hasTokenColumns(a.dataSource)).toBe(true)
    },
    MIGRATION_CASE_TIMEOUT_MS,
  )
})
