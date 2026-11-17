/**
 * The migration of LOC-182 up, down and up again on a database of its own: up refuses a second
 * recharge with one Dropi operation and leaves other payments alone; down takes the refusal away.
 */
import { config as dotenvConfig } from 'dotenv'
import { DataSource, QueryRunner } from 'typeorm'

import { AddDropiOperationUnique1794106072424 } from '../migrations/1794106072424-AddDropiOperationUnique'
import { databaseExists, withDisposableDatabase } from './support/disposable-database.fixture'
import { raceConnectionOptions } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

// Creating and dropping its own database can outlast jest's default 5 s under the parallel suite.
const MIGRATION_CASE_TIMEOUT_MS = 30_000

const RECHARGE = JSON.stringify({ dropiRecharge: { tokens: 10 } })

/** The two payments columns the index reads, as they stand before LOC-182. */
const createPayments = (runner: QueryRunner) =>
  runner.query(
    `CREATE TABLE payments (id serial PRIMARY KEY, "providerPaymentId" varchar, metadata jsonb)`,
  )

const insertPayment = (runner: QueryRunner, operation: string, metadata: string | null) =>
  runner.query('INSERT INTO payments ("providerPaymentId", metadata) VALUES ($1, $2)', [
    operation,
    metadata,
  ])

describe('AddDropiOperationUnique migration on its own database (LOC-182)', () => {
  let admin: DataSource

  beforeAll(async () => {
    admin = new DataSource(raceConnectionOptions())
    await admin.initialize()
  })

  afterAll(async () => {
    if (admin?.isInitialized) await admin.destroy()
  })

  it(
    'up refuses a second recharge with one operation, down accepts it, up runs again',
    async () => {
      // R15: red when the index predicate drops the recharge mark: the second card payment fails.
      const migration = new AddDropiOperationUnique1794106072424()
      const used = await withDisposableDatabase(admin, async (runner) => {
        await createPayments(runner)
        await migration.up(runner)
        await insertPayment(runner, 'op-1', RECHARGE)
        await expect(insertPayment(runner, 'op-1', RECHARGE)).rejects.toThrow(
          /UQ_payments_dropi_operation/,
        )
        await insertPayment(runner, 'ch-1', null)
        await insertPayment(runner, 'ch-1', null)

        await migration.down(runner)
        await insertPayment(runner, 'op-1', RECHARGE)
        // Two recharges already sharing an operation stop up: they are money, sorted out by hand.
        await expect(migration.up(runner)).rejects.toThrow(/UQ_payments_dropi_operation/)
        await runner.query(`DELETE FROM payments WHERE "providerPaymentId" = 'op-1'`)

        await migration.up(runner)
        await insertPayment(runner, 'op-2', RECHARGE)
        await expect(insertPayment(runner, 'op-2', RECHARGE)).rejects.toThrow(
          /UQ_payments_dropi_operation/,
        )
      })
      expect(await databaseExists(admin, used)).toBe(false)
    },
    MIGRATION_CASE_TIMEOUT_MS,
  )
})
