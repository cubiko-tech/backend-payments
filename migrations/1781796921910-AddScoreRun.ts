import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Fase 3 del scoring de crédito: tabla de runs masivos por período.
 * Guard de unicidad por índice parcial: un solo run pending|running por período.
 * Ver backend-payments/docs/DISEÑO_SCORING_CREDITO.md §6.3, §7.
 */
export class AddScoreRun1781796921910 implements MigrationInterface {
  name = 'AddScoreRun1781796921910'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "score_run" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "periodStart" date NOT NULL,
        "periodEnd" date NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "totalBrands" integer NOT NULL DEFAULT 0,
        "processed" integer NOT NULL DEFAULT 0,
        "eligible" integer NOT NULL DEFAULT 0,
        "vetoed" integer NOT NULL DEFAULT 0,
        "insufficient" integer NOT NULL DEFAULT 0,
        "errors" integer NOT NULL DEFAULT 0,
        "triggeredBy" character varying,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_score_run" PRIMARY KEY ("id")
      )
    `)
    await queryRunner.query(`
      CREATE INDEX "IDX_score_run_period"
      ON "score_run" ("periodStart", "periodEnd")
    `)
    // Un solo run activo (pending|running) por período: el índice parcial único
    // rechaza a nivel de BD un segundo run concurrente para el mismo período.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_score_run_active_period"
      ON "score_run" ("periodStart", "periodEnd")
      WHERE "status" IN ('pending', 'running')
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "score_run"`)
  }
}
