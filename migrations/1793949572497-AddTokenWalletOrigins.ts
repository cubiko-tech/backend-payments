import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddTokenWalletOrigins1793949572497 implements MigrationInterface {
  name = 'AddTokenWalletOrigins1793949572497'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "wallets" ADD "giftTokens" numeric(15,2) NOT NULL DEFAULT '0'`,
    )
    await queryRunner.query(
      `ALTER TABLE "wallets" ADD "purchasedTokens" numeric(15,2) NOT NULL DEFAULT '0'`,
    )
    await queryRunner.query(
      `ALTER TABLE "wallets" ADD "dropiTokens" numeric(15,2) NOT NULL DEFAULT '0'`,
    )
    await queryRunner.query(`ALTER TABLE "transactions" ADD "tokenOrigin" character varying(20)`)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "tokenOrigin"`)
    await queryRunner.query(`ALTER TABLE "wallets" DROP COLUMN "dropiTokens"`)
    await queryRunner.query(`ALTER TABLE "wallets" DROP COLUMN "purchasedTokens"`)
    await queryRunner.query(`ALTER TABLE "wallets" DROP COLUMN "giftTokens"`)
  }
}
