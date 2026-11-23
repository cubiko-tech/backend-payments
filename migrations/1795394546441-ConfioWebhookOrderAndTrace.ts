import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * The Confio notice watermark of a subscription, the state of a movement trace, and the two webhook
 * states of a notice that is kept without being applied: `ignored` and `out_of_order`.
 */
export class ConfioWebhookOrderAndTrace1795394546441 implements MigrationInterface {
  name = 'ConfioWebhookOrderAndTrace1795394546441'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "subscriptions" ADD COLUMN "providerWatermark" jsonb`)
    await queryRunner.query(`
      ALTER TABLE "subscription_events"
      ADD COLUMN "traceStatus" character varying(16) NOT NULL DEFAULT 'applied'
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_subscription_events_pending_trace"
      ON "subscription_events" ("subscriptionId", (metadata ->> 'providerEventId'))
      WHERE "traceStatus" = 'pending'
    `)
    await queryRunner.query(`ALTER TYPE "webhook_status_enum" ADD VALUE IF NOT EXISTS 'ignored'`)
    await queryRunner.query(
      `ALTER TYPE "webhook_status_enum" ADD VALUE IF NOT EXISTS 'out_of_order'`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Postgres cannot drop an enum value, so the type is rebuilt without the two new ones.
    await queryRunner.query(`
      UPDATE "webhook_events" SET "status" = 'processed'
      WHERE "status" IN ('ignored', 'out_of_order')
    `)
    // Its predicate compares against the old type, which blocks the column type change.
    await queryRunner.query(`DROP INDEX "IDX_webhook_events_pending"`)
    await queryRunner.query(`ALTER TABLE "webhook_events" ALTER COLUMN "status" DROP DEFAULT`)
    await queryRunner.query(`ALTER TYPE "webhook_status_enum" RENAME TO "webhook_status_enum_old"`)
    await queryRunner.query(
      `CREATE TYPE "webhook_status_enum" AS ENUM ('received', 'processing', 'processed', 'failed')`,
    )
    await queryRunner.query(`
      ALTER TABLE "webhook_events" ALTER COLUMN "status"
      TYPE "webhook_status_enum" USING "status"::text::"webhook_status_enum"
    `)
    await queryRunner.query(
      `ALTER TABLE "webhook_events" ALTER COLUMN "status" SET DEFAULT 'received'`,
    )
    await queryRunner.query(`DROP TYPE "webhook_status_enum_old"`)
    await queryRunner.query(`
      CREATE INDEX "IDX_webhook_events_pending" ON "webhook_events" ("status")
      WHERE "status" IN ('received', 'failed')
    `)
    // Without the column a pending or discarded trace would read as an applied movement.
    await queryRunner.query(`DELETE FROM "subscription_events" WHERE "traceStatus" <> 'applied'`)
    await queryRunner.query(`DROP INDEX "UQ_subscription_events_pending_trace"`)
    await queryRunner.query(`ALTER TABLE "subscription_events" DROP COLUMN "traceStatus"`)
    await queryRunner.query(`ALTER TABLE "subscriptions" DROP COLUMN "providerWatermark"`)
  }
}
