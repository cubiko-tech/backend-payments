import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

/**
 * Mapeo de nuestro plan del catálogo (`plans.slug` de backend-roles) al plan
 * recurrente equivalente del lado de ConfioPagos, **una fila por moneda y por
 * variante de prueba**.
 *
 * `currencyCode` de ConfioPagos es escalar: un plan allá = una moneda. Y el
 * período de prueba también se congela en el plan, así que la variante con
 * prueba y la variante sin prueba son DOS planes distintos allá. Por eso
 * `dropi-roax` necesita cuatro planes suyos (COP y USD × con y sin prueba) y
 * esta tabla es la única fuente de verdad de la resolución
 * `('dropi-roax', moneda, conPrueba) → confioName`.
 *
 * ⚠️ **Lo que se registra al crear el plan queda CONGELADO en ConfioPagos**:
 * `amountCents` y `trialPeriodDays` no se re-leen en cada cobro y no hay
 * endpoint de update. Un monto equivocado no se corrige: hay que crear otro
 * plan y re-mapearlo. Guardamos `amountCents` acá justamente para poder
 * detectar que el catálogo se movió y el plan de la pasarela quedó viejo.
 *
 * Los planes se crean **por ambiente** (dev y producción son stores distintos):
 * un `confioName` sembrado en dev no existe en producción.
 */
@Entity('confio_subscription_plan')
@Index(
  'UQ_confio_subscription_plan_slug_currency_trial',
  ['planSlug', 'currencyCode', 'withTrial'],
  { unique: true },
)
export class ConfioSubscriptionPlan {
  @PrimaryGeneratedColumn('uuid')
  id: string

  /** Slug de nuestro catálogo de planes (`plans.slug` en backend-roles), ej. `dropi-roax`. */
  @Column({ nullable: false })
  planSlug: string

  /** ISO-4217, ej. `COP` / `USD`. Se guarda y se compara en MAYÚSCULAS. */
  @Column({ length: 3, nullable: false })
  currencyCode: string

  /** `displayName` con el que el plan se dio (o se dará) de alta en ConfioPagos. */
  @Column({ nullable: false })
  displayName: string

  /**
   * Monto en **CENTAVOS**, tal como lo espera ConfioPagos: 19.900 COP → 1990000
   * y 6.99 USD → 699. No es el importe de `plan_prices`.
   *
   * Se aparta del `decimal(15,2)` que usan las columnas de dinero de este
   * esquema (ver `wallet.entity.ts:16`) porque acá NO es un importe con
   * decimales sino el entero exacto que viaja en el payload: COP quema tres
   * dígitos en centavos antes de que empiece el monto (un plan de 10M COP son
   * 1e9, a un orden de magnitud del techo de `int`), así que va `bigint`.
   *
   * El `transformer` es OBLIGATORIO: pg devuelve `bigint` como **string** y sin
   * él una lectura mandaría `amountCents: "1990000"` a ConfioPagos.
   */
  @Column({
    type: 'bigint',
    nullable: false,
    transformer: {
      to: (value: number) => value,
      from: (value: string) => Number(value),
    },
  })
  amountCents: number

  /**
   * Resource name del plan en ConfioPagos:
   * `stores/{store}/subscription-plans/{plan}` — **con guiones**, tal como lo
   * escribe su spec. Nunca `subscriptionPlans`: esta cadena se concatena para
   * el alta (`.../{plan}/subscriptions`) y un camelCase daría un 404 que
   * parece «ese endpoint no existe».
   *
   * `null` mientras el plan todavía no fue creado allá.
   */
  @Column({ nullable: true })
  confioName: string | null

  /** `pending` (sin crear en ConfioPagos) | `active` | `archived`. */
  @Column({ default: 'pending' })
  status: string

  /**
   * Si el plan de ConfioPagos al que apunta esta fila fue creado CON período de
   * prueba (`trialPeriodDays > 0`) o SIN él (`trialPeriodDays: 0`).
   *
   * Es una dimensión de la resolución y no un dato descriptivo: **la prueba vive
   * en el plan, no en la suscripción**. El body del alta no tiene ningún campo de
   * trial, así que la única forma de que un alta no obtenga prueba es apuntarla a
   * otro plan. Por eso `dropi-roax` necesita CUATRO filas —COP y USD, con y sin
   * prueba— y el índice único es el trío, no el par.
   *
   * Quién pide cuál: el alta de prueba (`startTrial`) pide `true`; el alta paga
   * (`startPaid`), que existe justamente para la marca que ya gastó su prueba,
   * pide `false`. Ver `ConfioPlanService.resolveConfioPlanName`.
   */
  @Column({ default: true })
  withTrial: boolean

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
