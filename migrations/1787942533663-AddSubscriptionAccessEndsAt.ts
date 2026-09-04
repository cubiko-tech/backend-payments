import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `subscriptions.accessEndsAt`: el instante en que termina el acceso YA pagado de una
 * fila con la baja pedida. Desde esta migración la baja
 * (`SubscriptionService.cancel`) deja de ser un corte inmediato —ya no mueve `status`
 * ni retira el plan de roles— y pasa a ser un apagado de renovación: sella
 * `autoRenew = false` + `cancelledAt` + esta fecha. El retiro efectivo lo ejecutará
 * después el cron que barra por el par `autoRenew = false` + `accessEndsAt` pasado
 * (`retiro-de-plan-al-vencer-el-periodo`): ⚠️ esa mitad TODAVÍA no está escrita, así
 * que por ahora esta columna sólo tiene escritores.
 *
 * INVARIANTE de la columna: **no nula ⇔ hay una baja pendiente**. Por eso todo camino
 * que revive una fila la vuelve a `NULL` junto con `cancelledAt`/`cancelReason`.
 *
 * **SIN backfill, y NULL es el default correcto.** Las filas ya `cancelled` perdieron
 * el acceso el mismo día que cancelaron —bajo la conducta vieja, que retiraba el plan
 * en el acto—, así que no tienen acceso pendiente que describir. Darles una fecha
 * retroactiva las volvería visibles para el cron de retiro y las haría degradar otra
 * vez, un efecto sobre marcas ya cerradas hace semanas. Con `NULL` quedan invisibles
 * para ese cron, que es exactamente lo que corresponde.
 *
 * Idempotente a propósito (`IF NOT EXISTS` / `IF EXISTS`): la corrida repetida no
 * pisa nada, y el `down` sólo devuelve el esquema sin tocar el resto de la fila.
 */
export class AddSubscriptionAccessEndsAt1787942533663 implements MigrationInterface {
  name = 'AddSubscriptionAccessEndsAt1787942533663'

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subscriptions"
        ADD COLUMN IF NOT EXISTS "accessEndsAt" TIMESTAMP WITH TIME ZONE
    `)
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "accessEndsAt"
    `)
  }
}
