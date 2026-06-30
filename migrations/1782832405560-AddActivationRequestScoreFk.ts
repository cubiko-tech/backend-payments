import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddActivationRequestScoreFk1782832405560 implements MigrationInterface {
  name = 'AddActivationRequestScoreFk1782832405560'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // creditScoreId referencia un snapshot en la misma DB (no es un id
    // cross-service): una FK protege contra ids huérfanos. credit_score es
    // append-only, así que RESTRICT por defecto no estorba.
    await queryRunner.query(`
      ALTER TABLE "credit_activation_request"
      ADD CONSTRAINT "FK_credit_activation_request_score"
      FOREIGN KEY ("creditScoreId") REFERENCES "credit_score" ("id")
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credit_activation_request"
      DROP CONSTRAINT IF EXISTS "FK_credit_activation_request_score"
    `)
  }
}
