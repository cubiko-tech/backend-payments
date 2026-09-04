import { MigrationInterface, QueryRunner } from 'typeorm'

/**
 * `pending` en `subscription_status_enum`: el estado del alta PAGA entre el alta y
 * el primer cobro (ver el JSDoc de `SubscriptionStatus` en
 * `src/subscription/entities/subscription.entity.ts`).
 *
 * SIN backfill, y no por prudencia: ninguna fila existente PUEDE ser `pending`
 * porque el valor todavía no lo escribe nadie (su productor es la tarea
 * `alta-paga-sin-prueba`). Mover filas vivas a este estado les cambiaría el ciclo
 * —dejarían de ser vistas por los crons y por el conjunto vivo del alta—, así que
 * esta migración sólo agranda el tipo.
 *
 * ⚠️ GOTCHA para la migración SIGUIENTE: TypeORM corre todas las pendientes en UNA
 * transacción (`transaction: 'all'`, el default) y Postgres no deja **usar** un valor
 * agregado con `ADD VALUE` hasta que esa transacción commitea. Una migración
 * posterior que inserte o actualice filas con `'pending'` fallaría si corre en la
 * misma pasada de `migration:run` que ésta. Si hace falta, va en una corrida aparte.
 * (Agregarlo sí es legal adentro de la transacción: dev corre Postgres 18.1 y eso
 * está permitido desde PG 12.)
 */
export class AddPendingSubscriptionStatus1788270915241 implements MigrationInterface {
  name = 'AddPendingSubscriptionStatus1788270915241'

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Idempotente, mismo patrón que `1782146588230-AddConfioProviderConfig.ts`
    // sobre `subscription_provider_enum`.
    await queryRunner.query(`
      ALTER TYPE "subscription_status_enum" ADD VALUE IF NOT EXISTS 'pending'
    `)
  }

  public async down(): Promise<void> {
    // NO-OP DELIBERADO. Postgres no sabe quitar un valor de un enum: habría que
    // recrear el tipo y reescribir la columna de la tabla entera, y un rollback no
    // es el lugar para eso. El precedente (`AddConfioProviderConfig`) tampoco
    // revierte su `ADD VALUE`. Un valor de más en el tipo no rompe nada: lo que
    // decide es el código, no el enum de la base.
  }
}
