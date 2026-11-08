import { randomUUID } from 'crypto'
import { DataSource, QueryRunner } from 'typeorm'

import { raceConnectionOptions } from './wallet-race.fixture'

export async function databaseExists(dataSource: DataSource, name: string) {
  return (await dataSource.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).length > 0
}

/**
 * Runs `run` on a runner of a database created for it and dropped afterwards, so a migration
 * going down never takes columns away from the suites sharing POSTGRES_DB.
 */
export async function withDisposableDatabase(
  admin: DataSource,
  run: (runner: QueryRunner, name: string) => Promise<void>,
): Promise<string> {
  const name = `payments_qa_payments_mig_${randomUUID().replace(/-/g, '')}`
  await admin.query(`CREATE DATABASE "${name}"`)
  const disposable = new DataSource({ ...raceConnectionOptions(), database: name })
  try {
    await disposable.initialize()
    const runner = disposable.createQueryRunner()
    try {
      await run(runner, name)
    } finally {
      await runner.release()
    }
  } finally {
    try {
      if (disposable.isInitialized) await disposable.destroy()
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
    }
  }
  return name
}
