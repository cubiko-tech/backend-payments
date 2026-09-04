import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * Marcador explícito `subscriptions.initialPaymentLinkIssuedAt`: la fila YA tiene su
 * link de pago inicial emitido en el alta (el `acceptanceUrl` de la suscripción
 * recurrente de ConfioPagos). `processTrialConversions` lo lee para no emitir un
 * SEGUNDO link —un checkout one-shot sobre una suscripción recurrente ya creada es un
 * riel de cobro paralelo—.
 *
 * **NULL es el default correcto para las filas existentes**: ninguna nació de un alta
 * que emitiera link de aceptación, así que el cron sigue tratándolas como hasta hoy.
 *
 * El backfill marca las filas `provider = 'confio'` con `providerSubscriptionId` no
 * nulo. Es un criterio de **una sola vez** para no re-cobrar lo ya dado de alta, y es
 * DISTINTO de la lógica de runtime, que discrimina sólo por esta columna. Se usa
 * `COALESCE("trialStart", "createdAt")` porque el instante exacto del link no quedó
 * registrado en ninguna parte y el alta es la mejor aproximación disponible.
 *
 * Idempotente a propósito: `ADD COLUMN IF NOT EXISTS` más el `IS NULL` del WHERE, que
 * impide que una re-corrida pise la marca que ya escribió el alta.
 */
export class AddInitialPaymentLinkIssuedAt1787862750922 implements MigrationInterface {
  name = 'AddInitialPaymentLinkIssuedAt1787862750922'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subscriptions"
        ADD COLUMN IF NOT EXISTS "initialPaymentLinkIssuedAt" TIMESTAMP WITH TIME ZONE
    `)

    await queryRunner.query(`
      UPDATE "subscriptions"
         SET "initialPaymentLinkIssuedAt" = COALESCE("trialStart", "createdAt")
       WHERE "provider" = 'confio'
         AND "providerSubscriptionId" IS NOT NULL
         AND "initialPaymentLinkIssuedAt" IS NULL
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "initialPaymentLinkIssuedAt"
    `)
  }
}
