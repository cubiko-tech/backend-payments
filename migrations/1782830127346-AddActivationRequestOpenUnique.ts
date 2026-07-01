import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddActivationRequestOpenUnique1782830127346 implements MigrationInterface {
  name = 'AddActivationRequestOpenUnique1782830127346'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Una marca no puede tener dos solicitudes "abiertas" a la vez. El chequeo
    // en código es racy (lee de la réplica antes de insertar en el primario);
    // este índice parcial único es la barrera real contra la carrera.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_credit_activation_request_open_brand"
      ON "credit_activation_request" ("brandId")
      WHERE "status" IN ('pending', 'contacted', 'qualified')
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_credit_activation_request_open_brand"`)
  }
}
