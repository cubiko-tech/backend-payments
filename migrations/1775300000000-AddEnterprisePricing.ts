import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddEnterprisePricing1775300000000 implements MigrationInterface {
  name = 'AddEnterprisePricing1775300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "enterprise_pricing" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "brandId" character varying NOT NULL,
        "monthlyPrice" numeric(15,2) NOT NULL,
        "currency" character varying(3) NOT NULL DEFAULT 'COP',
        "negotiatedBy" character varying,
        "validUntil" TIMESTAMP WITH TIME ZONE,
        "notes" text,
        "metadata" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_enterprise_pricing" PRIMARY KEY ("id")
      )
    `)

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_enterprise_pricing_brandId"
      ON "enterprise_pricing" ("brandId")
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "enterprise_pricing"`)
  }
}
