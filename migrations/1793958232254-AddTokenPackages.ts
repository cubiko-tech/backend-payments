import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Token package catalog, seeded with the ROAX Ads recharge tiers
 * (backend-ads `internal/token/domain/valueobjects/recharge_tier.go`), and the `token_package`
 * payment purpose that buys them.
 */
export class AddTokenPackages1793958232254 implements MigrationInterface {
  name = 'AddTokenPackages1793958232254'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "token_packages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "slug" character varying(50) NOT NULL,
        "label" character varying(100) NOT NULL,
        "priceUsd" numeric(15,2) NOT NULL,
        "purchasedTokens" numeric(15,2) NOT NULL,
        "bonusTokens" numeric(15,2) NOT NULL DEFAULT '0',
        "active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "UQ_token_packages_slug" UNIQUE ("slug"),
        CONSTRAINT "CHK_token_packages_price_min" CHECK ("priceUsd" >= 10),
        CONSTRAINT "CHK_token_packages_purchased" CHECK ("purchasedTokens" > 0),
        CONSTRAINT "CHK_token_packages_bonus" CHECK ("bonusTokens" >= 0),
        CONSTRAINT "PK_token_packages" PRIMARY KEY ("id")
      )`,
    )
    await queryRunner.query(
      `INSERT INTO "token_packages" ("slug", "label", "priceUsd", "purchasedTokens", "bonusTokens")
       VALUES
         ('basico', 'Recarga Mínima', 10, 10, 0),
         ('testeo-semanal', 'Testeo Semanal', 25, 25, 2),
         ('escala', 'Escala', 50, 50, 6),
         ('pro-agencia', 'Pro / Agencia', 100, 100, 15)`,
    )
    await queryRunner.query(`ALTER TYPE "payment_purpose_enum" ADD VALUE 'token_package'`)
  }

  /** Fails while any payment has purpose `token_package`: those rows have to go first. */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "payment_purpose_enum" RENAME TO "payment_purpose_enum_old"`,
    )
    await queryRunner.query(
      `CREATE TYPE "payment_purpose_enum" AS ENUM ('plan_purchase', 'wallet_recharge', 'service_payment')`,
    )
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "purpose" TYPE "payment_purpose_enum"
       USING "purpose"::text::"payment_purpose_enum"`,
    )
    await queryRunner.query(`DROP TYPE "payment_purpose_enum_old"`)
    await queryRunner.query(`DROP TABLE "token_packages"`)
  }
}
