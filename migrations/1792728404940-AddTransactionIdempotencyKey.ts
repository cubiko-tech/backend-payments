import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddTransactionIdempotencyKey1792728404940 implements MigrationInterface {
  name = 'AddTransactionIdempotencyKey1792728404940'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "transactions" ADD "idempotencyKey" character varying`)
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "UQ_86238dd0ae2d79be941104a5842" UNIQUE ("idempotencyKey")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "UQ_86238dd0ae2d79be941104a5842"`,
    )
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "idempotencyKey"`)
  }
}
