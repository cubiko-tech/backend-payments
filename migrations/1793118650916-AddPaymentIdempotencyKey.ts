import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddPaymentIdempotencyKey1793118650916 implements MigrationInterface {
  name = 'AddPaymentIdempotencyKey1793118650916'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "idempotencyKey" character varying`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_dd63c534618e9319a7807c4d3c" ON "payments" ("brandId", "idempotencyKey") `,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_dd63c534618e9319a7807c4d3c"`)
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "idempotencyKey"`)
  }
}
