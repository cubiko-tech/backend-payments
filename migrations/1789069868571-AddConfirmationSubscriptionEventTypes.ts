import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * El par de la CONFIRMACIÓN en `subscription_event_type_enum`: los dos valores con
 * los que el historial nombra el momento en que ConfioPagos reporta el alta como
 * aceptada —`confirmation_granted` cuando esa confirmación terminó en acceso y
 * `confirmation_not_granted` cuando no— (ver el JSDoc de `SubscriptionEventType`
 * en `src/subscription/entities/subscriptionEvent.entity.ts`).
 *
 * SIN backfill, y no por prudencia: ninguna fila existente PUEDE tener estos
 * valores porque el tipo todavía no los admite. Las filas ya escritas se siguen
 * leyendo como se escribieron —`reactivated` es una reactivación de verdad,
 * `trial_started` un alta con prueba— y reinterpretarlas sería falsear historial
 * ya guardado. Esta migración sólo agranda el tipo.
 *
 * QUIÉN LOS ESCRIBE: la aplicación, no una migración. El único productor es
 * `planearOtorgamiento` (`src/webhook/confio-subscription-webhook.service.ts`),
 * por donde pasan las tres vías de la confirmación.
 *
 * ⚠️ GOTCHA para la migración SIGUIENTE, el mismo que documentó
 * `AddPendingSubscriptionStatus`: TypeORM corre todas las pendientes en UNA
 * transacción (`transaction: 'all'`, el default) y Postgres no deja **usar** un
 * valor agregado con `ADD VALUE` hasta que esa transacción commitea. Una migración
 * posterior que inserte o actualice filas con `'confirmation_granted'` o
 * `'confirmation_not_granted'` fallaría si corre en la misma pasada de
 * `migration:run` que ésta. Si hace falta, va en una corrida aparte. (Agregarlo sí
 * es legal adentro de la transacción: dev corre Postgres 18.1 y eso está permitido
 * desde PG 12.)
 */
export class AddConfirmationSubscriptionEventTypes1789069868571 implements MigrationInterface {
  name = 'AddConfirmationSubscriptionEventTypes1789069868571'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotente, mismo patrón que `1788270915241-AddPendingSubscriptionStatus.ts`.
    // Los literales coinciden CARÁCTER POR CARÁCTER con los miembros del enum de
    // TypeScript: es lo único que los une.
    await queryRunner.query(`
      ALTER TYPE "subscription_event_type_enum" ADD VALUE IF NOT EXISTS 'confirmation_granted'
    `)
    await queryRunner.query(`
      ALTER TYPE "subscription_event_type_enum" ADD VALUE IF NOT EXISTS 'confirmation_not_granted'
    `)
  }

  public async down(): Promise<void> {
    // NO-OP DELIBERADO. Postgres no sabe quitar un valor de un enum: habría que
    // recrear el tipo y reescribir la columna de la tabla entera, y un rollback no
    // es el lugar para eso. El precedente (`AddPendingSubscriptionStatus`) tampoco
    // revierte su `ADD VALUE`. Un valor de más en el tipo no rompe nada: lo que
    // decide es el código, no el enum de la base.
  }
}
