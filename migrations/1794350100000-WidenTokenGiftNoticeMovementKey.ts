import { MigrationInterface, QueryRunner } from 'typeorm'

export class WidenTokenGiftNoticeMovementKey1794350100000 implements MigrationInterface {
  name = 'WidenTokenGiftNoticeMovementKey1794350100000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "token_gift_notices"
      ALTER COLUMN "movementKey" TYPE character varying(255)
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "token_gift_notices"
      ALTER COLUMN "movementKey" TYPE character varying(200)
    `)
  }
}
