import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCreditActivationRequests1782300000000 implements MigrationInterface {
  name = 'AddCreditActivationRequests1782300000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "credit_activation_request" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "brandId" character varying NOT NULL,
        "creditScoreId" uuid NOT NULL,
        "scoreTotal" integer NOT NULL,
        "tier" character varying,
        "fullName" character varying NOT NULL,
        "email" character varying NOT NULL,
        "phone" character varying NOT NULL,
        "source" character varying NOT NULL DEFAULT 'dropi',
        "status" character varying NOT NULL DEFAULT 'pending',
        "contactedAt" TIMESTAMP WITH TIME ZONE,
        "contactedBy" character varying,
        "notes" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_activation_request" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`
      CREATE INDEX "IDX_credit_activation_request_brand_created"
      ON "credit_activation_request" ("brandId", "createdAt")
    `)
    await queryRunner.query(`
      CREATE INDEX "IDX_credit_activation_request_brand_status"
      ON "credit_activation_request" ("brandId", "status")
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "credit_activation_request"`)
  }
}
