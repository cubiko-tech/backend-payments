import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Recharge invoicing (LOC-206): `payments.invoiceId` marks a recharge as invoiced, and `invoices.period`
 * (`YYYY-MM`) names the month a brand's consolidated invoice closes. One brand gets one invoice per period.
 */
export class AddRechargeInvoicing1794181627500 implements MigrationInterface {
  name = 'AddRechargeInvoicing1794181627500'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payments" ADD "invoiceId" uuid`)
    await queryRunner.query(`ALTER TABLE "invoices" ADD "period" varchar(7)`)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_invoices_brand_period" ON "invoices" ("brandId", "period")
       WHERE "period" IS NOT NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_invoices_brand_period"`)
    await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN "period"`)
    await queryRunner.query(`ALTER TABLE "payments" DROP COLUMN "invoiceId"`)
  }
}
