import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddActivationRequestRequestedBy1782832045077 implements MigrationInterface {
  name = 'AddActivationRequestRequestedBy1782832045077'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Atribución: quién originó la solicitud (id del usuario del token).
    await queryRunner.query(`
      ALTER TABLE "credit_activation_request"
      ADD COLUMN IF NOT EXISTS "requestedBy" character varying
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credit_activation_request" DROP COLUMN IF EXISTS "requestedBy"
    `)
  }
}
