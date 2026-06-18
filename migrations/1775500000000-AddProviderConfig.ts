import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddProviderConfig1775500000000 implements MigrationInterface {
  name = 'AddProviderConfig1775500000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "provider_config" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "country" character varying(2) NOT NULL,
        "provider" character varying NOT NULL,
        "isActive" boolean NOT NULL DEFAULT true,
        "priority" integer NOT NULL DEFAULT 0,
        "metadata" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_provider_config" PRIMARY KEY ("id")
      )
    `)

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_provider_config_country_provider"
      ON "provider_config" ("country", "provider")
    `)

    // Seed: proveedores por país
    // Colombia: Stripe, MercadoPago, Dropi
    await queryRunner.query(`
      INSERT INTO "provider_config" ("country", "provider", "isActive", "priority") VALUES
        ('CO', 'stripe', true, 1),
        ('CO', 'mercadopago', true, 2),
        ('CO', 'dropi', true, 3),
        ('MX', 'stripe', true, 1),
        ('MX', 'mercadopago', true, 2),
        ('US', 'stripe', true, 1)
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "provider_config"`)
  }
}
