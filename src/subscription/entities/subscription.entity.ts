import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum SubscriptionStatus { TRIAL = 'trial', ACTIVE = 'active', PAST_DUE = 'past_due', CANCELLED = 'cancelled', EXPIRED = 'expired' }
export enum SubscriptionProvider { STRIPE = 'stripe', MERCADOPAGO = 'mercadopago', WALLET = 'wallet', DROPI = 'dropi', CONFIO = 'confio' }

@Entity('subscriptions')
@Index(['brandId'], { unique: true })
@Index(['status', 'nextBillingDate'])
export class Subscription extends Content {
  @Column() brandId: string
  @Column() userId: string
  @Column() planSlug: string
  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.TRIAL }) status: SubscriptionStatus
  @Column({ type: 'uuid', nullable: true }) walletId: string
  @Column({ type: 'enum', enum: SubscriptionProvider }) provider: SubscriptionProvider
  @Column({ nullable: true }) providerSubscriptionId: string
  @Column({ type: 'timestamptz' }) currentPeriodStart: Date
  @Column({ type: 'timestamptz' }) currentPeriodEnd: Date
  @Column({ type: 'timestamptz', nullable: true }) trialStart: Date
  @Column({ type: 'timestamptz', nullable: true }) trialEnd: Date
  @Column({ default: true }) autoRenew: boolean
  // El link inicial del alta (el `acceptanceUrl` de ConfioPagos) ya fue emitido para ESTA fila: el cron
  // de conversión no debe emitir un segundo. Columna propia y no `metadata.confio` (jsonb no es un
  // marcador explícito) ni `providerSubscriptionId` (ese es criterio de backfill de una sola vez).
  @Column({ type: 'timestamptz', nullable: true }) initialPaymentLinkIssuedAt: Date
  @Column({ type: 'timestamptz', nullable: true }) cancelledAt: Date
  @Column({ type: 'text', nullable: true }) cancelReason: string
  // INVARIANTE: **no nula ⇔ la fila tiene una baja PENDIENTE**, y ese es el instante exacto en que
  // termina el acceso ya pagado. La baja (`SubscriptionService.cancel`) apaga la renovación y sella
  // esta fecha, pero YA NO cambia `status` —la fila sigue en `trial`/`active`/`past_due` mientras
  // tenga acceso—, así que esta columna es la ÚNICA fuente de la fecha de corte: no se deduce del
  // estado ni de `currentPeriodEnd` (una fila viva y renovable también tiene período abierto).
  // Su consumidor SERÁ el cron de `retiro-de-plan-al-vencer-el-periodo` (BACKLOG, épica 002),
  // que degradará leyendo el par `autoRenew = false` + `accessEndsAt` ya pasado. ⚠️ Ese cron
  // TODAVÍA NO EXISTE: hoy esta columna sólo tiene ESCRITORES. Hasta que aterrice, lo único que
  // corta el acceso es el `expiresAt` que `backend-roles` ya recibía en el alta, que coincide
  // con esta fecha por construcción pero es un mecanismo incidental.
  // Todo camino que REVIVE una fila (`startTrial` reusando una fila muerta, `reactivate`,
  // `checkout.createOrRenewSubscription`) tiene que volverla a `null` junto con
  // `cancelledAt`/`cancelReason`: una fecha de corte vieja sobre una suscripción que se renueva
  // es una mentira visible en `GET /subscription/current`. Y todo camino que MUEVE el fin del
  // servicio con una baja pendiente tiene que correrla también (`admin.controller.ts`,
  // `extendSubscription`), o extender el período no extiende nada.
  // ⚠️ LECTORES QUE TODAVÍA NO LA MIRAN, y por eso desafinan mientras la baja está pendiente:
  // `metrics.service.ts` cuenta la fila en MRR y en «activas» (filtra `status IN
  // ('active','trial')`) aunque ya no vaya a renovar, y al mismo tiempo la cuenta como churn por
  // su `SubscriptionEvent`. Corregir la métrica es una decisión de negocio, anotada en el INBOX.
  // SIN índice a propósito: la tabla tiene decenas de filas y el cron barrerá de todos modos por
  // `autoRenew`; el índice se agrega el día que ese cron lo justifique con volumen real.
  @Column({ type: 'timestamptz', nullable: true }) accessEndsAt: Date
  @Column({ type: 'uuid', nullable: true }) lastPaymentId: string
  @Column({ type: 'timestamptz', nullable: true }) nextBillingDate: Date
  @Column({ type: 'int', default: 0 }) retryCount: number
  @Column({ type: 'jsonb', nullable: true }) metadata: any
}
