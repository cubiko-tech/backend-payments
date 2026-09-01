import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

/**
 * Estados locales de una suscripción. `PENDING` va ÚLTIMO a propósito: es el orden
 * físico en que `ALTER TYPE … ADD VALUE` lo agrega en Postgres
 * (`migrations/1788270915241-AddPendingSubscriptionStatus.ts`), y con la lista TS
 * ordenada igual las dos no divergen. Hoy da lo mismo —ninguna consulta del servicio
 * ordena por `status`—, pero el día que alguna lo haga la sorpresa ya está evitada.
 *
 * `PENDING` es el estado del alta **PAGA** entre el alta y el primer cobro: la
 * suscripción existe de los dos lados pero todavía no pagó nada, así que no habilita
 * nada. Modela el `PENDING_ACCEPTANCE` de ConfioPagos —el único estado en el que
 * viaja el `acceptanceUrl`, el link portador del alta (`confio.types.ts:145`)—, pero
 * NO se deriva de él: lo escribe NUESTRO endpoint de alta, nunca el wire status del
 * webhook (ver `CONFIO_ESTADOS_SIN_EFECTO` en
 * `confio-subscription-webhook.service.ts`).
 *
 * ⚠️ Su ÚNICO productor será `alta-paga-sin-prueba`, la tarea que entra
 * inmediatamente después de ésta: **hoy no lo escribe nadie, y eso es esperado, no un
 * cableado a medias**. Lo que existe ya es el contrato: los tres conjuntos que
 * deciden sobre `status` (`TERMINAL_SUBSCRIPTION_STATUSES` y
 * `LIVE_SUBSCRIPTION_STATUSES` acá, `ESTADOS_TERMINALES` en el webhook) declaran por
 * qué lo dejan afuera, y sus tests lo fijan.
 *
 * El alta de **PRUEBA no cambia**: sigue naciendo `TRIAL` y sigue asignando el plan
 * en roles desde el alta (`assignPlanToBrand(brandId, planSlug, trialEnd)`,
 * `subscription.service.ts`), así que la prueba de 15 días arranca en el alta como
 * siempre.
 */
export enum SubscriptionStatus {
  TRIAL = 'trial',
  ACTIVE = 'active',
  PAST_DUE = 'past_due',
  CANCELLED = 'cancelled',
  EXPIRED = 'expired',
  PENDING = 'pending',
}
export enum SubscriptionProvider { STRIPE = 'stripe', MERCADOPAGO = 'mercadopago', WALLET = 'wallet', DROPI = 'dropi', CONFIO = 'confio' }

/**
 * Ciclos YA CERRADOS, y el mismo conjunto que `ESTADOS_TERMINALES` en
 * `confio-subscription-webhook.service.ts`.
 *
 * Ya NO es el complemento de los estados vivos (`trial`/`active`/`past_due`): desde
 * que existe `pending` hay un estado que no está ni acá ni en
 * `LIVE_SUBSCRIPTION_STATUSES`, y está afuera de los dos a propósito. No leer este
 * conjunto como «todo lo que no está vivo».
 *
 * Una fila así no tiene acceso que preservar —la baja no le sella `accessEndsAt`— y
 * **no se revive**: la vuelta es un alta nueva por checkout, detrás de un `Payment`
 * real. Vive acá y no en `subscription.service.ts` porque `TasksService` decide con
 * el mismo conjunto y un hecho con dos dueños deriva.
 *
 * ⚠️ **`pending` NO entra**, y no es un olvido: `ConfioSubscriptionWebhookService`
 * usa el conjunto espejo para decidir si un `SUCCEEDED` es una RESURRECCIÓN. Con
 * `pending` adentro, `planearCobro` calcularía `revive = true`, devolvería
 * `roles: undefined` y el PRIMER cobro del alta paga —que no es una resurrección
 * sino el cobro que la suscripción estaba esperando— movería la fila a `active` SIN
 * reponer el plan en roles: la marca paga y no habilita nada. Lo fija por el otro
 * lado el caso «el primer cobro exitoso sobre una fila `pending` la activa y le
 * asigna el plan en roles» de `confio-subscription-webhook.service.spec.ts`.
 */
export const TERMINAL_SUBSCRIPTION_STATUSES = [SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED]

/**
 * Estados en los que la marca tiene servicio VIGENTE: es el criterio POSITIVO de
 * «esta fila tiene derecho a su plan». `expired` y `cancelled` son ciclos terminados.
 *
 * ⚠️ `pending` NO entra, y el motivo es operativo, no taxonómico. La tabla tiene
 * índice ÚNICO por `brandId`: un alta nueva no crea otra fila, REUSA la que hay. Si
 * `pending` contara como vigente, la marca que abrió su link de pago y no lo aceptó
 * quedaría con un 409 `SUBSCRIPTION_ALREADY_EXISTS` permanente —su fila no está viva
 * pero la bloquearía igual— y no tendría forma de reintentar el alta nunca. Lo fija el
 * caso «una fila `pending` no bloquea el alta» de `subscription.service.spec.ts`.
 *
 * ⚠️ ACCESO — por qué este conjunto es el que decide el derecho y NO el complemento de
 * `TERMINAL_SUBSCRIPTION_STATUSES`: desde que existe `pending` los dos ya no son
 * complementarios, y un predicado negativo (`!TERMINAL…`) le concede el plan PAGO a
 * una fila que todavía no pagó su primer ciclo. Le pasó a
 * `TasksService.reponerPlanSiSigueVigente`, que hoy lee de acá. Todo predicado de
 * derecho se escribe ENUMERANDO este conjunto; el estado que se agregue mañana tiene
 * que entrar a mano, no colarse por la negación.
 *
 * Vive acá —y no en `subscription.service.ts`, su dueño original— por la misma razón
 * que el conjunto de arriba: `TasksService` decide con él y un hecho con dos dueños
 * deriva.
 */
export const LIVE_SUBSCRIPTION_STATUSES = [
  SubscriptionStatus.TRIAL,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
]

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
  // INVARIANTE: marca DURABLE de prueba consumida — **`trialStart` no nula ⇔ la marca ya usó su prueba**.
  // Es lo que hace cumplible la regla «una prueba por marca» de la épica 002 sobre una tabla de UNA fila
  // por marca (índice único por `brandId`): la fila se reusa ciclo tras ciclo, así que la única memoria de
  // que la prueba ya se gastó son estas dos fechas. Su ÚNICO lector es el guard `TRIAL_ALREADY_USED` de
  // `SubscriptionService.startTrial` (pre-guardia barata + relectura bajo lock).
  // Hoy ningún camino las limpia. ⚠️ Pero esta lista NO se cierra con `grep trialStart`: los caminos que
  // guardan la fila ENTERA desde un payload las escriben sin nombrarlas nunca. Escritores auditados:
  //   · `SubscriptionService.startTrial` — el único que las PONE (`now`/`trialEnd`), incluso cuando REUSA
  //     una fila muerta. Es el alta, y ahí es donde la prueba se consume.
  //   · `SubscriptionService.create` (`POST /subscription`) — el que el grep NO encuentra: hace
  //     `repository.create(data)` + `save(data)` con el body. Escribe lo que le manden, y con un `id` ajeno
  //     el `save` es un UPDATE de la fila de OTRA marca. Lo que lo cierra no está en este archivo: es la
  //     lista blanca de `subscription/dto/create-subscription.dto.ts` —sin `id`, sin `trialStart`, sin
  //     `trialEnd`— que aplica el `ValidationPipe` global. Volver a poner `@Body() data: any` ahí reabre el
  //     agujero completo: sin metatype el pipe no filtra NADA.
  //   · `SubscriptionService.cancel` / `reactivate` — guardan la fila releída bajo lock sin nombrarlas.
  //   · `CheckoutService.createOrRenewSubscription` — revive la fila campo por campo (estado, período,
  //     `autoRenew`, `cancelledAt`, `accessEndsAt`…) y NO las nombra: recomprar NO devuelve la prueba.
  //   · `TasksService` — los tres cierres escriben con `update` y una lista CERRADA de columnas:
  //     `endTrialWithoutPayment`, `expireSubscriptions` y `expireCancelledSubscriptions`.
  //   · `ConfioSubscriptionWebhookService.aplicar` / `AdminController.extendSubscription` — tampoco.
  // Custodiado por tests, citados por NOMBRE porque los números de línea se pudren solos:
  // `tasks.service.spec.ts` asserta los tres parches de cron por IGUALDAD EXACTA del payload
  // (`toHaveBeenCalledWith` y el helper `esperarCierre`), así que agregarles `trialStart: null` los pone
  // rojos hoy —verificado a mano—; `subscription.service.spec.ts` → «la prueba no vuelve tras la baja ni
  // tras el vencimiento» cubre los dos estados terminales y la ventana de baja PENDIENTE;
  // `checkout.service.spec.ts` cubre que la recompra guarda la fila con las dos fechas intactas; y
  // `dto/create-subscription.dto.spec.ts` fija la lista blanca del alta genérica.
  // ⚠️ Todos esos candados miran el PAYLOAD que escribe el código, no lo que acepta Postgres: un camino
  // nuevo que limpie estas columnas con SQL crudo pasaría por al lado. Si vas a agregar uno, esta
  // invariante es lo que estás rompiendo. La vuelta de una marca que ya usó su prueba es SIEMPRE pagando.
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
  // Su ÚNICO lector es el cron horario `TasksService.expireCancelledSubscriptions`, que degrada a
  // `free` leyendo el par `autoRenew = false` + `accessEndsAt` ya pasado y recién ahí cierra la
  // fila —y en ese mismo compare-and-set vuelve esta columna a `null`, porque una fila terminal
  // ya no tiene baja PENDIENTE (lo mismo hace `expireSubscriptions` con las de la intersección)—.
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
  // SIN índice a propósito: la tabla tiene decenas de filas y el cron barre de todos modos por
  // `autoRenew` (y ordena por esta columna con `take`, un sort en memoria irrelevante a esta
  // escala); el índice se agrega el día que el volumen lo justifique, y exige migración.
  @Column({ type: 'timestamptz', nullable: true }) accessEndsAt: Date
  @Column({ type: 'uuid', nullable: true }) lastPaymentId: string
  @Column({ type: 'timestamptz', nullable: true }) nextBillingDate: Date
  @Column({ type: 'int', default: 0 }) retryCount: number
  @Column({ type: 'jsonb', nullable: true }) metadata: any
}
