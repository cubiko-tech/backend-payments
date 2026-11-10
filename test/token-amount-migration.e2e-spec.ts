import { config as dotenvConfig } from 'dotenv'
import { DataSource, QueryRunner } from 'typeorm'

import { AddTokenAmountPurpose1794250000000 } from '../migrations/1794250000000-AddTokenAmountPurpose'
import { databaseExists, withDisposableDatabase } from './support/disposable-database.fixture'
import { raceConnectionOptions } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const MIGRATION_CASE_TIMEOUT_MS = 30_000

async function createPaymentPurposeEnum(runner: QueryRunner) {
  await runner.query(
    `CREATE TYPE "payment_purpose_enum"
     AS ENUM ('plan_purchase', 'wallet_recharge', 'service_payment', 'token_package', 'token_recharge')`,
  )
  await runner.query(
    `CREATE TABLE payments (
       id serial PRIMARY KEY,
       purpose "payment_purpose_enum" NOT NULL
     )`,
  )
}

async function labelsOf(runner: QueryRunner, type: string): Promise<string[]> {
  const rows = await runner.query(
    `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = $1 ORDER BY e.enumsortorder`,
    [type],
  )
  return rows.map((row: { label: string }) => row.label)
}

const insertPayment = (runner: QueryRunner, purpose: string) =>
  runner.query('INSERT INTO payments (purpose) VALUES ($1)', [purpose])

describe('AddTokenAmountPurpose migration on its own database (LOC-250)', () => {
  let admin: DataSource

  beforeAll(async () => {
    admin = new DataSource(raceConnectionOptions())
    await admin.initialize()
  })

  afterAll(async () => {
    if (admin?.isInitialized) await admin.destroy()
  })

  it(
    'goes down keeping token_package and token_recharge payments, refusing while a token_amount row exists',
    async () => {
      // R15: red when down omits token_recharge or token_package from the recreated enum: down fails.
      const migration = new AddTokenAmountPurpose1794250000000()
      const used = await withDisposableDatabase(admin, async (runner) => {
        await createPaymentPurposeEnum(runner)
        await migration.up(runner)
        expect(await labelsOf(runner, 'payment_purpose_enum')).toContain('token_amount')

        await insertPayment(runner, 'token_amount')
        await runner.startTransaction()
        await expect(migration.down(runner)).rejects.toThrow()
        await runner.rollbackTransaction()
        await runner.query(`DELETE FROM payments`)

        await insertPayment(runner, 'token_package')
        await insertPayment(runner, 'token_recharge')

        await migration.down(runner)
        expect(await labelsOf(runner, 'payment_purpose_enum')).not.toContain('token_amount')
        expect(await runner.query('SELECT purpose FROM payments ORDER BY id')).toEqual([
          { purpose: 'token_package' },
          { purpose: 'token_recharge' },
        ])

        await migration.up(runner)
        expect(await labelsOf(runner, 'payment_purpose_enum')).toContain('token_amount')
      })
      expect(await databaseExists(admin, used)).toBe(false)
    },
    MIGRATION_CASE_TIMEOUT_MS,
  )
})
