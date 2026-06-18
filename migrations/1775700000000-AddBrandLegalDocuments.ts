import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddBrandLegalDocuments1775700000000 implements MigrationInterface {
  name = 'AddBrandLegalDocuments1775700000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "document_status_enum" AS ENUM ('pending', 'verified', 'rejected')
    `)

    await queryRunner.query(`
      CREATE TABLE "brand_legal_documents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "brandId" character varying NOT NULL,
        "country" character varying(2) NOT NULL,
        "documentType" character varying NOT NULL,
        "documentUrl" character varying NOT NULL,
        "status" "document_status_enum" NOT NULL DEFAULT 'pending',
        "verifiedAt" TIMESTAMP WITH TIME ZONE,
        "verifiedBy" character varying,
        "rejectionReason" text,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_brand_legal_documents" PRIMARY KEY ("id")
      )
    `)

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_brand_legal_documents_brandId_type"
      ON "brand_legal_documents" ("brandId", "documentType")
    `)

    await queryRunner.query(`
      CREATE INDEX "IDX_brand_legal_documents_status"
      ON "brand_legal_documents" ("status")
      WHERE "status" = 'pending'
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "brand_legal_documents"`)
    await queryRunner.query(`DROP TYPE "document_status_enum"`)
  }
}
