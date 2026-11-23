import { config as dotenvConfig } from 'dotenv'
import { DataSource, QueryRunner } from 'typeorm'

import { ConfioWebhookOrderAndTrace1795394546441 } from '../migrations/1795394546441-ConfioWebhookOrderAndTrace'
import { databaseExists, withDisposableDatabase } from './support/disposable-database.fixture'
import { raceConnectionOptions } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const MIGRATION_CASE_TIMEOUT_MS = 30_000

/** The three tables the migration touches, as `InitialSchema` leaves them. */
async function createTables(runner: QueryRunner) {
  await runner.query(`CREATE TABLE subscriptions (id uuid PRIMARY KEY)`)
  await runner.query(
    `CREATE TABLE subscription_events (
       id serial PRIMARY KEY,
       "subscriptionId" uuid NOT NULL,
       metadata jsonb
     )`,
  )
  await runner.query(
    `CREATE TYPE "webhook_status_enum" AS ENUM ('received', 'processing', 'processed', 'failed')`,
  )
  await runner.query(
    `CREATE TABLE webhook_events (
       id serial PRIMARY KEY,
       status "webhook_status_enum" NOT NULL DEFAULT 'received'
     )`,
  )
  await runner.query(
    `CREATE INDEX "IDX_webhook_events_pending" ON "webhook_events" ("status")
     WHERE "status" IN ('received', 'failed')`,
  )
}

async function labelsOf(runner: QueryRunner): Promise<string[]> {
  const rows = await runner.query(
    `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typname = 'webhook_status_enum' ORDER BY e.enumsortorder`,
  )
  return rows.map((row: { label: string }) => row.label)
}

const SUB = '44444444-4444-4444-8444-444444444444'

describe('ConfioWebhookOrderAndTrace migration on its own database (LOC-272)', () => {
  let admin: DataSource

  beforeAll(async () => {
    admin = new DataSource(raceConnectionOptions())
    await admin.initialize()
  })

  afterAll(async () => {
    if (admin?.isInitialized) await admin.destroy()
  })

  it(
    'goes down with ignored and out-of-order events and a pending trace, and up again',
    async () => {
      // R15: red if down keeps the pending trace, leaves a status the old type lacks, or drops the
      // pending index for good.
      const migration = new ConfioWebhookOrderAndTrace1795394546441()
      const used = await withDisposableDatabase(admin, async (runner) => {
        await createTables(runner)
        await migration.up(runner)
        expect(await labelsOf(runner)).toEqual([
          'received',
          'processing',
          'processed',
          'failed',
          'ignored',
          'out_of_order',
        ])

        await runner.query(
          `INSERT INTO webhook_events (status) VALUES ('ignored'), ('out_of_order')`,
        )
        await runner.query(
          `INSERT INTO subscription_events ("subscriptionId", metadata, "traceStatus")
           VALUES ($1, '{"providerEventId":"a"}', 'pending'), ($1, '{"providerEventId":"b"}', 'applied')`,
          [SUB],
        )
        await expect(
          runner.query(
            `INSERT INTO subscription_events ("subscriptionId", metadata, "traceStatus")
             VALUES ($1, '{"providerEventId":"a"}', 'pending')`,
            [SUB],
          ),
        ).rejects.toThrow(/UQ_subscription_events_pending_trace/)

        await migration.down(runner)

        expect(await labelsOf(runner)).toEqual(['received', 'processing', 'processed', 'failed'])
        const statuses = await runner.query(`SELECT status FROM webhook_events ORDER BY id`)
        expect(statuses.map((r: { status: string }) => r.status)).toEqual([
          'processed',
          'processed',
        ])
        const traces = await runner.query(
          `SELECT metadata ->> 'providerEventId' AS id FROM subscription_events`,
        )
        expect(traces).toEqual([{ id: 'b' }])
        const index = await runner.query(
          `SELECT 1 FROM pg_indexes WHERE indexname = 'IDX_webhook_events_pending'`,
        )
        expect(index).toHaveLength(1)

        await migration.up(runner)
        expect(await labelsOf(runner)).toContain('out_of_order')
      })

      expect(await databaseExists(admin, used)).toBe(false)
    },
    MIGRATION_CASE_TIMEOUT_MS,
  )
})
