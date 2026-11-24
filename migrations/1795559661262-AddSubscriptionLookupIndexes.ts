import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Indexes the two subscription lookups that scanned the whole table: every Confio notice finds
 * its row by `providerSubscriptionId`, and the hourly cut filters and sorts by `accessEndsAt`.
 * Generated from `subscription.entity.ts`; down drops both and leaves the rows untouched.
 */
export class AddSubscriptionLookupIndexes1795559661262 implements MigrationInterface {
  name = 'AddSubscriptionLookupIndexes1795559661262'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_subscriptions_access_ends_at" ON "subscriptions" ("accessEndsAt") `,
    )
    await queryRunner.query(
      `CREATE INDEX "IDX_subscriptions_provider_subscription_id" ON "subscriptions" ("providerSubscriptionId") `,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_subscriptions_provider_subscription_id"`)
    await queryRunner.query(`DROP INDEX "public"."IDX_subscriptions_access_ends_at"`)
  }
}
