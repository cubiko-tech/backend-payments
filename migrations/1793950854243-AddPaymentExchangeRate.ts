import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddPaymentExchangeRate1793950854243 implements MigrationInterface {
  name = 'AddPaymentExchangeRate1793950854243'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "exchangeRate" numeric(12,2)`)
    await queryRunner.query(`ALTER TABLE "payments" ADD "exchangeRateDate" date`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "exchangeRateDate"`)
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "exchangeRate"`)
  }
}
