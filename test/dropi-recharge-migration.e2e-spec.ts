/**
 * The migration of LOC-174 up, down and up again on a database of its own: down keeps every value
 * in use before it, and refuses while a recharge from Dropi exists.
 */
import { config as dotenvConfig } from 'dotenv'
import { DataSource, QueryRunner } from 'typeorm'

import { AddDropiWalletRecharge1794093004141 } from '../migrations/1794093004141-AddDropiWalletRecharge'
import { databaseExists, withDisposableDatabase } from './support/disposable-database.fixture'
import { raceConnectionOptions } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

// Creating and dropping its own database can outlast jest's default 5 s under the parallel suite.
const MIGRATION_CASE_TIMEOUT_MS = 30_000

/** The two payment enums and the payments columns that use them, as they stand before LOC-174. */
async function createPaymentEnums(runner: QueryRunner) {
  await runner.query(
    `CREATE TYPE "payment_provider_enum" AS ENUM ('stripe', 'mercadopago', 'dropi', 'wallet', 'confio')`,
  )
  await runner.query(
    `CREATE TYPE "payment_purpose_enum"
     AS ENUM ('plan_purchase', 'wallet_recharge', 'service_payment', 'token_package')`,
  )
  await runner.query(
    `CREATE TABLE payments (
       id serial PRIMARY KEY,
       provider "payment_provider_enum" NOT NULL,
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

const insertPayment = (runner: QueryRunner, provider: string, purpose: string) =>
  runner.query('INSERT INTO payments (provider, purpose) VALUES ($1, $2)', [provider, purpose])

describe('AddDropiWalletRecharge migration on its own database (LOC-174)', () => {
  let admin: DataSource

  beforeAll(async () => {
    admin = new DataSource(raceConnectionOptions())
    await admin.initialize()
  })

  afterAll(async () => {
    if (admin?.isInitialized) await admin.destroy()
  })

  it(
    'goes down keeping token_package and confio payments, refusing while a recharge exists',
    async () => {
      // R15: red when down recreates the enums of the token package mold: the token_package
      // R15: and confio rows no longer cast and down fails.
      const migration = new AddDropiWalletRecharge1794093004141()
      const used = await withDisposableDatabase(admin, async (runner) => {
        await createPaymentEnums(runner)
        await migration.up(runner)
        await insertPayment(runner, 'dropi_wallet', 'token_recharge')
        // In a transaction, as `migration:revert` runs it: the failed down leaves nothing behind.
        await runner.startTransaction()
        await expect(migration.down(runner)).rejects.toThrow()
        await runner.rollbackTransaction()
        await runner.query(`DELETE FROM payments`)
        await insertPayment(runner, 'confio', 'token_package')

        await migration.down(runner)
        expect(await labelsOf(runner, 'payment_provider_enum')).not.toContain('dropi_wallet')
        expect(await labelsOf(runner, 'payment_purpose_enum')).not.toContain('token_recharge')
        expect(await runner.query('SELECT provider, purpose FROM payments')).toEqual([
          { provider: 'confio', purpose: 'token_package' },
        ])

        await migration.up(runner)
        expect(await labelsOf(runner, 'payment_provider_enum')).toContain('dropi_wallet')
        expect(await labelsOf(runner, 'payment_purpose_enum')).toContain('token_recharge')
      })
      expect(await databaseExists(admin, used)).toBe(false)
    },
    MIGRATION_CASE_TIMEOUT_MS,
  )
})
