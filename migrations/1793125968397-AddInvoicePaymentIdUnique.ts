import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddInvoicePaymentIdUnique1793125968397 implements MigrationInterface {
  name = 'AddInvoicePaymentIdUnique1793125968397'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_invoices_payment_id" ON "invoices" ("paymentId")`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_invoices_payment_id"`)
  }
}
