import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Service credentials Pagos accepts from other services, one row per client, with only the SHA-256
 * of the key. No seed: a key is born only through the admin route, which shows it once.
 */
export class AddServiceCredentials1794089219514 implements MigrationInterface {
  name = 'AddServiceCredentials1794089219514'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "service_credentials" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "client" character varying(50) NOT NULL,
        "keyHash" character(64) NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "UQ_service_credentials_client" UNIQUE ("client"),
        CONSTRAINT "CHK_service_credentials_key_hash" CHECK ("keyHash" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "PK_service_credentials" PRIMARY KEY ("id")
      )`,
    )
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "service_credentials"`)
  }
}
