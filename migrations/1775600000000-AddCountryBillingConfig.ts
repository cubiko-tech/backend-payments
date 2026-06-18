import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddCountryBillingConfig1775600000000 implements MigrationInterface {
  name = 'AddCountryBillingConfig1775600000000'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "country_billing_config" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "country" character varying(2) NOT NULL,
        "countryName" character varying NOT NULL,
        "taxIdRequired" boolean NOT NULL DEFAULT false,
        "taxIdTypes" jsonb NOT NULL DEFAULT '[]',
        "taxRegimeRequired" boolean NOT NULL DEFAULT false,
        "taxRegimes" jsonb NOT NULL DEFAULT '[]',
        "electronicInvoiceRequired" boolean NOT NULL DEFAULT false,
        "electronicInvoiceProvider" character varying,
        "requiredFields" jsonb NOT NULL DEFAULT '[]',
        "legalDocuments" jsonb NOT NULL DEFAULT '[]',
        "invoicePrefix" character varying,
        "invoiceFormat" character varying,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_country_billing_config" PRIMARY KEY ("id")
      )
    `)

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_country_billing_config_country"
      ON "country_billing_config" ("country")
    `)

    // Seed: Colombia (completo)
    await queryRunner.query(`
      INSERT INTO "country_billing_config"
        ("country", "countryName", "taxIdRequired", "taxIdTypes", "taxRegimeRequired", "taxRegimes",
         "electronicInvoiceRequired", "electronicInvoiceProvider",
         "requiredFields", "legalDocuments", "invoicePrefix", "invoiceFormat")
      VALUES (
        'CO', 'Colombia', true,
        '["NIT","CC","CE","PASSPORT"]'::jsonb,
        true,
        '["responsable_iva","no_responsable","gran_contribuyente","simplificado"]'::jsonb,
        true, 'siigo',
        '["legalName","taxId","taxIdType","taxRegime","address","city","country","email"]'::jsonb,
        '["rut","camara_comercio"]'::jsonb,
        'CK', 'PREFIX-YYYY-NNNNNN'
      )
    `)

    // Seed: México (parcial)
    await queryRunner.query(`
      INSERT INTO "country_billing_config"
        ("country", "countryName", "taxIdRequired", "taxIdTypes", "taxRegimeRequired", "taxRegimes",
         "electronicInvoiceRequired", "electronicInvoiceProvider",
         "requiredFields", "legalDocuments", "invoicePrefix", "invoiceFormat")
      VALUES (
        'MX', 'México', true,
        '["RFC","CURP"]'::jsonb,
        true,
        '["general","simplificado","incorporacion_fiscal"]'::jsonb,
        true, null,
        '["legalName","taxId","taxIdType","taxRegime","address","city","state","postalCode","country","email"]'::jsonb,
        '["constancia_situacion_fiscal"]'::jsonb,
        'CK-MX', 'PREFIX-YYYY-NNNNNN'
      )
    `)

    // Seed: Estados Unidos (mínimo)
    await queryRunner.query(`
      INSERT INTO "country_billing_config"
        ("country", "countryName", "taxIdRequired", "taxIdTypes",
         "electronicInvoiceRequired",
         "requiredFields", "legalDocuments", "invoicePrefix", "invoiceFormat")
      VALUES (
        'US', 'Estados Unidos', false,
        '["EIN","SSN"]'::jsonb,
        false,
        '["legalName","country","email"]'::jsonb,
        '[]'::jsonb,
        'CK-US', 'PREFIX-YYYY-NNNNNN'
      )
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "country_billing_config"`)
  }
}
