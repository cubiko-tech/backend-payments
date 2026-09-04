import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Tabla de mapeo `('planSlug', 'currencyCode') → confioName` entre nuestro
 * catálogo de planes y los planes recurrentes de ConfioPagos, más las dos filas
 * de `dropi-roax` (COP y USD).
 *
 * ⚠️ **Los montos van en CENTAVOS**: 19.900 COP → 1990000 y 6.99 USD → 699.
 * `plan_prices` de backend-roles guarda 19900 y 6.99; no es el mismo número.
 * Equivocarlo por un factor 100 cobra cien veces de más o de menos y **no se
 * puede corregir**: ConfioPagos congela el monto al crear el plan y no expone
 * update, así que hay que crear un plan nuevo y re-mapearlo.
 *
 * Las filas nacen en `status = 'pending'` con `confioName = NULL` porque el alta
 * REAL contra ConfioPagos no entra en esta migración. Al 2026-08-25 el store de
 * dev (`01KZBY100Z3HD2X997XE0DN8PW`) tiene **un** plan y **no es el nuestro**:
 * `"Roax Test"` con `amountCents: 5990000` (59.900 COP), creado a mano de prueba.
 * No sirve para `dropi-roax`, que va a 1990000, y como ConfioPagos no permite
 * editar el monto, mapearlo cobraría el triple. Por eso `confioName` queda NULL
 * hasta que se cree el plan correcto.
 *
 * Idempotente a propósito (`IF NOT EXISTS` + `ON CONFLICT DO NOTHING`): una
 * re-corrida no puede pisar el `confioName` que escriba después el alta real.
 */
export class AddConfioSubscriptionPlanMapping1787670464952 implements MigrationInterface {
  name = 'AddConfioSubscriptionPlanMapping1787670464952'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "confio_subscription_plan" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "planSlug" character varying NOT NULL,
        "currencyCode" character varying(3) NOT NULL,
        "displayName" character varying NOT NULL,
        "amountCents" bigint NOT NULL,
        "confioName" character varying,
        "status" character varying NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_confio_subscription_plan" PRIMARY KEY ("id")
      )
    `)

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_confio_subscription_plan_slug_currency"
        ON "confio_subscription_plan" ("planSlug", "currencyCode")
    `)

    await queryRunner.query(`
      INSERT INTO "confio_subscription_plan"
        ("planSlug", "currencyCode", "displayName", "amountCents", "confioName", "status")
      VALUES
        ('dropi-roax', 'COP', 'ROAX Pro (Dropi) - Mensual COP', 1990000, NULL, 'pending'),
        ('dropi-roax', 'USD', 'ROAX Pro (Dropi) - Mensual USD', 699, NULL, 'pending')
      ON CONFLICT ("planSlug", "currencyCode") DO NOTHING
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "confio_subscription_plan"`)
  }
}
