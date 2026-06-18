import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddWalletLabel1775400000000 implements MigrationInterface {
  name = 'AddWalletLabel1775400000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wallets" ADD COLUMN "label" character varying
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "wallets" DROP COLUMN "label"
    `)
  }
}
