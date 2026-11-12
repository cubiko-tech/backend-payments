import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddTokenAmountPurpose1794250000000 implements MigrationInterface {
  name = 'AddTokenAmountPurpose1794250000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "payment_purpose_enum" ADD VALUE 'token_amount'`)
  }

  /** Fails while any payment has purpose `token_amount`: those rows have to go first. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "payment_purpose_enum" RENAME TO "payment_purpose_enum_old"`,
    )
    await queryRunner.query(
      `CREATE TYPE "payment_purpose_enum" AS ENUM (
        'plan_purchase', 'wallet_recharge', 'service_payment', 'token_package', 'token_recharge'
      )`,
    )
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "purpose" TYPE "payment_purpose_enum" USING "purpose"::text::"payment_purpose_enum"`,
    )
    await queryRunner.query(`DROP TYPE "payment_purpose_enum_old"`)
  }
}
