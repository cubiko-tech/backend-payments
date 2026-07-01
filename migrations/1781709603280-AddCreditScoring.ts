import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Fase 2 del scoring de crédito: config de escala versionada, perfil de crédito,
 * check de buró y snapshot inmutable de score.
 * Ver backend-payments/docs/DISEÑO_SCORING_CREDITO.md §7.
 */
export class AddCreditScoring1781709603280 implements MigrationInterface {
  name = 'AddCreditScoring1781709603280'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "credit_score_scale_config" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "version" integer NOT NULL,
        "baseCurrency" character varying(5) NOT NULL DEFAULT 'COP',
        "status" character varying NOT NULL DEFAULT 'draft',
        "config" jsonb NOT NULL,
        "createdBy" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_score_scale_config" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_credit_scale_config_version"
      ON "credit_score_scale_config" ("version")
    `)

    await queryRunner.query(`
      CREATE TABLE "credit_bureau_check" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "provider" character varying NOT NULL,
        "document" character varying NOT NULL,
        "documentType" character varying NOT NULL,
        "country" character varying,
        "rawScore" numeric(10,2),
        "scaleMax" integer,
        "band" character varying,
        "raw" jsonb,
        "checkedAt" TIMESTAMP WITH TIME ZONE,
        "validUntil" TIMESTAMP WITH TIME ZONE,
        "createdBy" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_bureau_check" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`
      CREATE INDEX "IDX_credit_bureau_check_document"
      ON "credit_bureau_check" ("document", "documentType", "country")
    `)

    await queryRunner.query(`
      CREATE TABLE "credit_profile" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "brandId" character varying NOT NULL,
        "document" character varying,
        "documentType" character varying,
        "country" character varying,
        "consentGrantedAt" TIMESTAMP WITH TIME ZONE,
        "consentVersion" character varying,
        "consentSource" character varying,
        "status" character varying NOT NULL DEFAULT 'active',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_profile" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_credit_profile_brandId"
      ON "credit_profile" ("brandId")
    `)

    await queryRunner.query(`
      CREATE TABLE "credit_score" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "brandId" character varying NOT NULL,
        "runId" uuid,
        "scaleVersion" integer NOT NULL,
        "periodStart" date NOT NULL,
        "periodEnd" date NOT NULL,
        "effectiveStart" date NOT NULL,
        "effectiveEnd" date NOT NULL,
        "periodAdjusted" boolean NOT NULL DEFAULT false,
        "inputs" jsonb NOT NULL,
        "subscores" jsonb NOT NULL,
        "bureauCheckId" uuid,
        "bureauBand" character varying,
        "total" integer NOT NULL,
        "tierByScore" character varying,
        "tier" character varying,
        "tierCappedBy" character varying,
        "conditions" jsonb NOT NULL,
        "scoreStatus" character varying NOT NULL,
        "eligibilityStatus" character varying NOT NULL,
        "calculatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "triggeredBy" character varying,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_score" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`
      CREATE INDEX "IDX_credit_score_brand_created"
      ON "credit_score" ("brandId", "createdAt")
    `)
    // Idempotencia del worker de runs (Fase 3): un snapshot por (brand, run).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_credit_score_brand_run"
      ON "credit_score" ("brandId", "runId")
      WHERE "runId" IS NOT NULL
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "credit_score"`)
    await queryRunner.query(`DROP TABLE "credit_profile"`)
    await queryRunner.query(`DROP TABLE "credit_bureau_check"`)
    await queryRunner.query(`DROP TABLE "credit_score_scale_config"`)
  }
}
