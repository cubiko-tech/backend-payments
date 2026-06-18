import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddMetricsSnapshots1775800000000 implements MigrationInterface {
  name = 'AddMetricsSnapshots1775800000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "metrics_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "date" date NOT NULL,
        "type" character varying NOT NULL,
        "data" jsonb NOT NULL,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_metrics_snapshots" PRIMARY KEY ("id")
      )
    `)

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_metrics_snapshots_date_type"
      ON "metrics_snapshots" ("date", "type")
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "metrics_snapshots"`)
  }
}
