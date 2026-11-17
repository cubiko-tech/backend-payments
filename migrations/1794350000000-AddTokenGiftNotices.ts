import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddTokenGiftNotices1794350000000 implements MigrationInterface {
  name = 'AddTokenGiftNotices1794350000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "token_gift_notices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "brandId" character varying(255) NOT NULL,
        "amount" numeric(15,2) NOT NULL,
        "balanceAfter" numeric(15,2) NOT NULL,
        "movementKey" character varying(200) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pendiente',
        CONSTRAINT "PK_token_gift_notices" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_token_gift_notices_movement_key" UNIQUE ("movementKey")
      )
    `)
    await queryRunner.query(`
      CREATE INDEX "IDX_token_gift_notices_brand_status"
      ON "token_gift_notices" ("brandId", "status", "createdAt")
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "token_gift_notices"`)
  }
}
