import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Tercera dimensión del mapeo de planes: `withTrial`.
 *
 * ConfioPagos define el período de prueba **en el plan**, no en la suscripción.
 * Su `CreateSubscriptionRequest` no tiene ningún campo de trial —sólo
 * `correlationId`, `firstChargeAmountCents`, `redirectUri`, `acceptanceExpireTime`
 * y `buyer`— y en su OpenAPI `trialPeriodDays` aparece únicamente en
 * `SubscriptionPlan` y en `CreateSubscriptionPlanRequest`. Verificado contra su
 * spec vivo el 2026-09-04.
 *
 * Consecuencia: la única forma de que un alta NO obtenga prueba es apuntarla a
 * OTRO plan, creado con `trialPeriodDays: 0` (valor documentado: «Usa `0` si no
 * hay prueba», rango 0–365). Tampoco alcanza con editar el de 15 días: no existe
 * endpoint de update de planes.
 *
 * Sin esto, la marca que ya gastó su prueba y vuelve por el alta PAGA corre
 * contra el mismo plan de 15 días y ConfioPagos le regala otros 15 —que después
 * cobra—.
 *
 * Las filas existentes quedan en `true`: los dos planes ya creados allá tienen
 * `trialPeriodDays: 15`. Las dos nuevas nacen con `confioName = NULL` y
 * `status = 'pending'` por el mismo motivo que la migración que sembró la tabla:
 * el alta REAL de un plan en ConfioPagos es una acción operativa, no una
 * migración. Mientras no se creen, el alta paga falla con
 * `CONFIO_PLAN_NOT_CREATED` — ruidoso y con su propio código, que es justo lo
 * que se busca: nunca caer en silencio al plan con prueba.
 */
export class AddConfioPlanTrialVariant1788532576741 implements MigrationInterface {
  name = 'AddConfioPlanTrialVariant1788532576741'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "confio_subscription_plan"
        ADD COLUMN IF NOT EXISTS "withTrial" boolean NOT NULL DEFAULT true
    `)

    // El índice único viejo (planSlug, currencyCode) haría IMPOSIBLE la segunda
    // fila por moneda: se reemplaza por el trío. No es un índice de más sino el
    // mismo, corregido.
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_confio_subscription_plan_slug_currency"
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_confio_subscription_plan_slug_currency_trial"
        ON "confio_subscription_plan" ("planSlug", "currencyCode", "withTrial")
    `)

    await queryRunner.query(`
      INSERT INTO "confio_subscription_plan"
        ("planSlug", "currencyCode", "displayName", "amountCents", "confioName", "status", "withTrial")
      VALUES
        ('dropi-roax', 'COP', 'ROAX Pro (Dropi) - Mensual COP sin prueba', 1990000, NULL, 'pending', false),
        ('dropi-roax', 'USD', 'ROAX Pro (Dropi) - Mensual USD sin prueba', 699, NULL, 'pending', false)
      ON CONFLICT ("planSlug", "currencyCode", "withTrial") DO NOTHING
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Se borran SÓLO las filas sin prueba: las de prueba son las originales y
    // borrarlas dejaría al alta de trial sin mapeo.
    await queryRunner.query(`
      DELETE FROM "confio_subscription_plan" WHERE "withTrial" = false
    `)
    await queryRunner.query(`
      DROP INDEX IF EXISTS "UQ_confio_subscription_plan_slug_currency_trial"
    `)
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_confio_subscription_plan_slug_currency"
        ON "confio_subscription_plan" ("planSlug", "currencyCode")
    `)
    await queryRunner.query(`
      ALTER TABLE "confio_subscription_plan" DROP COLUMN IF EXISTS "withTrial"
    `)
  }
}
