import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Scopes webhook event deduplication uniqueness to `(provider, providerEventId)`
 * instead of `providerEventId` alone.
 *
 * `down` restores the global `UQ_webhook_events_provider_id` constraint; it fails
 * without deleting rows if two providers already share the same `providerEventId`.
 */
export class WebhookEventsUniquePerProvider1793775625851 implements MigrationInterface {
  name = 'WebhookEventsUniquePerProvider1793775625851'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_events" DROP CONSTRAINT "UQ_webhook_events_provider_id"`,
    )
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_webhook_events_provider_event" ON "webhook_events" ("provider", "providerEventId")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_webhook_events_provider_event"`)
    await queryRunner.query(
      `ALTER TABLE "webhook_events" ADD CONSTRAINT "UQ_webhook_events_provider_id" UNIQUE ("providerEventId")`,
    )
  }
}
