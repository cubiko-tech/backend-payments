import { MigrationInterface, QueryRunner } from 'typeorm'

export class CreateTrmWeeklyRates1794415099807 implements MigrationInterface {
  name = 'CreateTrmWeeklyRates1794415099807'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "trm_weekly_rates" ("weekStart" date NOT NULL, "rate" numeric(12,2) NOT NULL, "rateDate" date NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_e2193bc1f07660fbdf4a3d18ed1" PRIMARY KEY ("weekStart"))`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "trm_weekly_rates"`)
  }
}
