/**
 * The migration of LOC-350 up, down and up again on a database of its own: up leaves each lookup
 * column with its index, down takes both away by name, and up puts them back.
 */
import { config as dotenvConfig } from 'dotenv'
import { DataSource, QueryRunner } from 'typeorm'

import { AddSubscriptionLookupIndexes1795559661262 } from '../migrations/1795559661262-AddSubscriptionLookupIndexes'
import { databaseExists, withDisposableDatabase } from './support/disposable-database.fixture'
import { raceConnectionOptions } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

// Creating and dropping its own database can outlast jest's default 5 s under the parallel suite.
const MIGRATION_CASE_TIMEOUT_MS = 30_000

const PROVIDER_ID_INDEX = 'IDX_subscriptions_provider_subscription_id'
const ACCESS_END_INDEX = 'IDX_subscriptions_access_ends_at'

/** The two subscriptions columns the indexes read, as they stand before LOC-350. */
const createSubscriptions = (runner: QueryRunner) =>
  runner.query(
    `CREATE TABLE subscriptions (
       id serial PRIMARY KEY,
       "providerSubscriptionId" varchar,
       "accessEndsAt" timestamptz
     )`,
  )

/** Index name to its definition, for the two indexes this migration owns. */
async function lookupIndexes(runner: QueryRunner): Promise<Record<string, string>> {
  const rows: { indexname: string; indexdef: string }[] = await runner.query(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE tablename = 'subscriptions' AND indexname = ANY($1)`,
    [[PROVIDER_ID_INDEX, ACCESS_END_INDEX]],
  )
  return Object.fromEntries(rows.map((row) => [row.indexname, row.indexdef]))
}

describe('AddSubscriptionLookupIndexes migration on its own database (LOC-350)', () => {
  let admin: DataSource

  beforeAll(async () => {
    admin = new DataSource(raceConnectionOptions())
    await admin.initialize()
  })

  afterAll(async () => {
    if (admin?.isInitialized) await admin.destroy()
  })

  it(
    'up indexes both lookup columns, down drops each index, up adds them again',
    async () => {
      // R15: red when down() loses the DROP INDEX of accessEndsAt: that index outlives the revert.
      const migration = new AddSubscriptionLookupIndexes1795559661262()
      const used = await withDisposableDatabase(admin, async (runner) => {
        await createSubscriptions(runner)

        await migration.up(runner)
        const afterUp = await lookupIndexes(runner)
        expect(afterUp[PROVIDER_ID_INDEX]).toContain('("providerSubscriptionId")')
        expect(afterUp[ACCESS_END_INDEX]).toContain('("accessEndsAt")')

        await migration.down(runner)
        expect(await lookupIndexes(runner)).toEqual({})

        await migration.up(runner)
        expect(Object.keys(await lookupIndexes(runner)).sort()).toEqual([
          ACCESS_END_INDEX,
          PROVIDER_ID_INDEX,
        ])
      })
      expect(await databaseExists(admin, used)).toBe(false)
    },
    MIGRATION_CASE_TIMEOUT_MS,
  )
})
