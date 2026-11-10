/**
 * The migration of LOC-206 up, down and up again on a database of its own: up refuses a second
 * invoice of a brand and period and adds `payments.invoiceId`; down takes both away.
 */
import { config as dotenvConfig } from 'dotenv'
import { DataSource, QueryRunner } from 'typeorm'

import { AddRechargeInvoicing1794181627500 } from '../migrations/1794181627500-AddRechargeInvoicing'
import { databaseExists, withDisposableDatabase } from './support/disposable-database.fixture'
import { raceConnectionOptions } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

// Creating and dropping its own database can outlast jest's default 5 s under the parallel suite.
const MIGRATION_CASE_TIMEOUT_MS = 30_000

/** The columns the migration touches, as they stand before LOC-206. */
const createTables = async (runner: QueryRunner) => {
  await runner.query(`CREATE TABLE payments (id serial PRIMARY KEY)`)
  await runner.query(
    `CREATE TABLE invoices (id serial PRIMARY KEY, "brandId" varchar NOT NULL,
     "invoiceNumber" varchar NOT NULL UNIQUE)`,
  )
}

// Each invoice gets its own number, so only the new index can refuse it.
const insertInvoice = (runner: QueryRunner, brandId: string, period: string | null, n: string) =>
  runner.query('INSERT INTO invoices ("brandId", period, "invoiceNumber") VALUES ($1, $2, $3)', [
    brandId,
    period,
    n,
  ])

const hasColumn = async (runner: QueryRunner, table: string, column: string) =>
  (
    await runner.query(
      'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2',
      [table, column],
    )
  ).length > 0

describe('AddRechargeInvoicing migration on its own database (LOC-206)', () => {
  let admin: DataSource

  beforeAll(async () => {
    admin = new DataSource(raceConnectionOptions())
    await admin.initialize()
  })

  afterAll(async () => {
    if (admin?.isInitialized) await admin.destroy()
  })

  it(
    'up refuses a second invoice of a brand and period, down accepts it, up runs again',
    async () => {
      // R15: red when up skips UQ_invoices_brand_period: the second October invoice is inserted.
      const migration = new AddRechargeInvoicing1794181627500()
      const used = await withDisposableDatabase(admin, async (runner) => {
        await createTables(runner)
        await migration.up(runner)
        expect(await hasColumn(runner, 'payments', 'invoiceId')).toBe(true)
        await insertInvoice(runner, 'brand-1', '2026-10', 'N1')
        await expect(insertInvoice(runner, 'brand-1', '2026-10', 'N2')).rejects.toThrow(
          /UQ_invoices_brand_period/,
        )
        await insertInvoice(runner, 'brand-1', '2026-11', 'N3')
        await insertInvoice(runner, 'brand-2', '2026-10', 'N4')
        await insertInvoice(runner, 'brand-1', null, 'N5')
        await insertInvoice(runner, 'brand-1', null, 'N6')

        await migration.down(runner)
        expect(await hasColumn(runner, 'payments', 'invoiceId')).toBe(false)
        expect(await hasColumn(runner, 'invoices', 'period')).toBe(false)

        await migration.up(runner)
        await insertInvoice(runner, 'brand-1', '2026-10', 'N7')
        await expect(insertInvoice(runner, 'brand-1', '2026-10', 'N8')).rejects.toThrow(
          /UQ_invoices_brand_period/,
        )
      })
      expect(await databaseExists(admin, used)).toBe(false)
    },
    MIGRATION_CASE_TIMEOUT_MS,
  )
})
