/**
 * Every migration run on an empty database leaves exactly the schema the entities describe: the
 * check `migration:generate` makes, so it has nothing to emit. A change to an entity without its
 * migration, or a migration the entities do not mirror, turns this case red with the SQL it wants.
 */
import { join } from 'path'
import { config as dotenvConfig } from 'dotenv'
import { DataSource, DataSourceOptions } from 'typeorm'

import { databaseExists, withDisposableDatabase } from './support/disposable-database.fixture'
import { raceConnectionOptions } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

// Running the whole migration chain on a new database takes several seconds.
const DRIFT_CASE_TIMEOUT_MS = 120_000

/** The same globs `src/orm/write.ts` points at in `dist/`, read from the sources. */
function schemaSourceOptions(database: string): DataSourceOptions {
  return {
    ...raceConnectionOptions(),
    database,
    entities: [join(__dirname, '../src/**/*.entity.ts')],
    migrations: [join(__dirname, '../migrations/*.ts')],
    migrationsTableName: 'migrations',
  }
}

describe('Schema drift between migrations and entities', () => {
  let admin: DataSource

  beforeAll(async () => {
    admin = new DataSource(raceConnectionOptions())
    await admin.initialize()
  })

  afterAll(async () => {
    if (admin?.isInitialized) await admin.destroy()
  })

  it(
    'leaves migration:generate nothing to emit after every migration ran',
    async () => {
      // R15: red when `enumName` leaves the status column of subscription.entity.ts: the builder
      // wants to rename subscription_status_enum.
      const used = await withDisposableDatabase(admin, async (_runner, name) => {
        const source = new DataSource(schemaSourceOptions(name))
        await source.initialize()
        try {
          await source.runMigrations()
          const pending = await source.driver.createSchemaBuilder().log()
          expect(pending.upQueries.map((query) => query.query)).toEqual([])
        } finally {
          await source.destroy()
        }
      })
      expect(await databaseExists(admin, used)).toBe(false)
    },
    DRIFT_CASE_TIMEOUT_MS,
  )
})
