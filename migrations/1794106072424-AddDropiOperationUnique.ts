import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * One Dropi operation closes one recharge (LOC-182). Recharges are told apart by `metadata.dropiRecharge`:
 * `dropi_wallet` is added in the same single migration transaction and cannot be used before its commit.
 * Up fails while two recharges already hold the same operation (see docs/RIESGOS.md).
 */
export class AddDropiOperationUnique1794106072424 implements MigrationInterface {
  name = 'AddDropiOperationUnique1794106072424'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_payments_dropi_operation" ON "payments" ("providerPaymentId")
       WHERE "providerPaymentId" IS NOT NULL AND "metadata" -> 'dropiRecharge' IS NOT NULL`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_payments_dropi_operation"`)
  }
}
