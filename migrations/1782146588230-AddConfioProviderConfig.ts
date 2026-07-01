import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddConfioProviderConfig1782146588230 implements MigrationInterface {
  name = 'AddConfioProviderConfig1782146588230'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Agregar 'confio' a los enums de proveedor (suscripción y pago, idempotente).
    await queryRunner.query(`
      ALTER TYPE "subscription_provider_enum" ADD VALUE IF NOT EXISTS 'confio'
    `)
    await queryRunner.query(`
      ALTER TYPE "payment_provider_enum" ADD VALUE IF NOT EXISTS 'confio'
    `)

    // Habilitar ConfioPagos como proveedor para Colombia (prioridad alta).
    // Idempotente: no falla si ya existe (índice único country+provider).
    await queryRunner.query(`
      INSERT INTO "provider_config" ("country", "provider", "isActive", "priority")
      VALUES ('CO', 'confio', true, 0)
      ON CONFLICT ("country", "provider") DO UPDATE
        SET "isActive" = EXCLUDED."isActive", "priority" = EXCLUDED."priority"
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DELETE FROM "provider_config" WHERE "country" = 'CO' AND "provider" = 'confio'
    `)
  }
}
