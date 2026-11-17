import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * The `dropi_wallet` payment provider and the `token_recharge` purpose of a recharge paid with the
 * Dropi balance (LOC-174).
 */
export class AddDropiWalletRecharge1794093004141 implements MigrationInterface {
  name = 'AddDropiWalletRecharge1794093004141'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "payment_provider_enum" ADD VALUE 'dropi_wallet'`)
    await queryRunner.query(`ALTER TYPE "payment_purpose_enum" ADD VALUE 'token_recharge'`)
  }

  /** Fails while any payment is a `dropi_wallet` recharge: those rows have to go first. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await recreateEnum(
      queryRunner,
      'payment_provider_enum',
      'provider',
      `'stripe', 'mercadopago', 'dropi', 'wallet', 'confio'`,
    )
    await recreateEnum(
      queryRunner,
      'payment_purpose_enum',
      'purpose',
      `'plan_purchase', 'wallet_recharge', 'service_payment', 'token_package'`,
    )
  }
}

async function recreateEnum(runner: QueryRunner, type: string, column: string, values: string) {
  await runner.query(`ALTER TYPE "${type}" RENAME TO "${type}_old"`)
  await runner.query(`CREATE TYPE "${type}" AS ENUM (${values})`)
  await runner.query(
    `ALTER TABLE "payments" ALTER COLUMN "${column}" TYPE "${type}" USING "${column}"::text::"${type}"`,
  )
  await runner.query(`DROP TYPE "${type}_old"`)
}
