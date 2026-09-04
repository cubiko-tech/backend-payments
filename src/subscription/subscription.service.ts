import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'
import {
  Subscription,
  SubscriptionStatus,
  SubscriptionProvider,
  TERMINAL_SUBSCRIPTION_STATUSES,
  LIVE_SUBSCRIPTION_STATUSES,
} from './entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from './entities/subscriptionEvent.entity'
import { EventBusService } from '../event-bus/event-bus.service'
import { ConfioTrialService } from './confio-trial.service'
import { ConfioCancellationService } from './confio-cancellation.service'
import { ConfioSubscriptionWebhookService } from '../webhook/confio-subscription-webhook.service'
import { RequestException } from '../shared/exception/request.exception'

/**
 * Topes del BORDE para los dos textos libres de la baja. No son gusto: los dos
 * viajan a una escritura que ocurre DESPUÉS de que ConfioPagos ya canceló, y
 * `subscription_events.triggeredBy` es `varchar` (255) `NOT NULL`
 * (`migrations/1742600000000-InitialSchema.ts`). Un valor más largo revienta la
 * transacción con la baja ya hecha del otro lado, y el reintento vuelve a
 * reventar igual: su cancelación es idempotente, el límite de la columna no.
 */
const MAX_CANCEL_REASON_LENGTH = 500
const MAX_TRIGGERED_BY_LENGTH = 255

/**
 * Violación de índice único en Postgres (verificado contra dev: `code=23505`).
 *
 * Predicado COPIADO —no extraído— de `webhook.service.ts:16`,
 * `credit-run.service.ts:262` y `credit.service.ts:608`: la convención ya está
 * establecida por triplicado en el servicio y centralizarla sería un drive-by
 * fuera del alcance de esta tarea.
 */
function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505'
}

/**
 * Resource name de la suscripción que una fila tiene en ConfioPagos, o `undefined`.
 *
 * Mismo orden de preferencia que `getAcceptanceLink`: `metadata.confio.name` es la
 * fuente principal y `providerSubscriptionId` el respaldo de las filas que escribió
 * otro camino. Se lee acá una sola vez para que las dos altas no puedan divergir en
 * QUÉ suscripción reemplazan.
 */
function nombreAnterior(fila?: Subscription | null): string | undefined {
  return fila?.metadata?.confio?.name || fila?.providerSubscriptionId || undefined
}

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name)

  constructor(
    @InjectRepository(Subscription, 'DBWrite')
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(Subscription, 'DBRead')
    private readonly subscriptionReadRepository: Repository<Subscription>,
    @InjectRepository(SubscriptionEvent, 'DBWrite')
    private readonly subscriptionEventRepository: Repository<SubscriptionEvent>,
    @InjectRepository(SubscriptionEvent, 'DBRead')
    private readonly subscriptionEventReadRepository: Repository<SubscriptionEvent>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
    private readonly eventBus: EventBusService,
    private readonly confioTrial: ConfioTrialService,
    private readonly confioCancellation: ConfioCancellationService,
    private readonly confioWebhook: ConfioSubscriptionWebhookService,
  ) {}

  /**
   * Iniciar la prueba gratuita creando la suscripción en ConfioPagos.
   *
   * El alta de ConfioPagos **no cobra**: devuelve la suscripción en
   * `PENDING_ACCEPTANCE` y un `acceptanceUrl`, el «único link inicial» del
   * criterio 1 de la épica 002. El comprador acepta ahí, registra su tarjeta y a
   * partir de entonces ConfioPagos cobra cada período por su cuenta y nos avisa
   * por webhook.
   *
   * **EL ALTA NO REPARTE ACCESO.** La fila nace en `pending` y `backend-roles` no se
   * toca acá: el plan lo otorga la CONFIRMACIÓN de ConfioPagos —el webhook
   * `TRIALING`, `confio-subscription-webhook.service.ts`—, que es el único momento
   * en que consta que el comprador aceptó y registró tarjeta. Es la regla «no se
   * otorga el plan sin suscripción de verdad» (Manuel, 2026-09-02), y cierra el
   * desfase que este docblock declaraba sin resolver: nuestra prueba ya no puede
   * empezar antes que la de ellos, porque empieza CON la de ellos.
   *
   * ORDEN, que sigue siendo la invariante: **todo lo falible primero, la escritura
   * después**. Guards de lectura → `POST` a ConfioPagos → transacción corta que
   * escribe la fila y el `TRIAL_STARTED`. Un 5xx de ConfioPagos deja a la marca
   * REINTENTABLE (sin `trialStart`, sin fila nueva) en vez de quemada en
   * `TRIAL_ALREADY_USED`.
   *
   * ⚠️ RESIDUAL ACEPTADO: si la escritura local falla DESPUÉS del `POST`, queda del
   * lado de ConfioPagos una suscripción huérfana en `PENDING_ACCEPTANCE`, que vence
   * sola y no cobra. Se elige eso antes que quemarle la prueba a la marca. Ya no
   * queda además un plan colgado en roles: acá no se asigna ninguno.
   *
   * Ese residual vale SÓLO para la huérfana que nadie aceptó, y por poco: si el
   * comprador llegara a aceptarla quedaría en `TRIALING` y COBRARÍA, sin fila que lo
   * explique. Por eso el alta que REUSA una fila cancela primero la suscripción
   * anterior del otro lado (`reemplazaA`): medido el 2026-09-03, ConfioPagos admite
   * varias simultáneas del mismo comprador —había tres— y no tiene reactivar.
   *
   * ⚠️ Lo que SIGUE abierto del desfase, y es de ellos: su link de aceptación vence
   * a los 7 días por default, contra los 15 de nuestra prueba. Quien no acepte en
   * esa ventana no consigue acceso —correcto— pero tampoco puede retomar: la fila
   * queda `pending` con un link muerto y el alta responde
   * `SUBSCRIPTION_PENDING_ACCEPTANCE`. Retomarla es de otra tarea.
   *
   * ⚠️ CARRERA DEL WEBHOOK, verificada y sin efecto hoy: el `POST` dispara
   * `subscription.subscriptionStatusChanged` con `PENDING_ACCEPTANCE` ANTES de que
   * exista nuestra fila (la escritura llega después del `POST`, hasta ~10 s más
   * tarde). `ConfioSubscriptionWebhookService.handle` no la resuelve, loguea un
   * warn y retorna (`:119`), y aunque la resolviera `PENDING_ACCEPTANCE` está en
   * `CONFIO_ESTADOS_SIN_EFECTO` (`:38`). El evento igual queda en `webhook_events`
   * y `retryWebhook(eventId)` (`webhook.service.ts:333`) lo re-despacha con la
   * idempotencia por marcador. Lo que NO está cubierto: un evento CON efecto en esa
   * ventana (un `TRIALING` exige que un humano registre tarjeta, así que no puede
   * caer ahí) se perdería salvo re-despacho manual.
   *
   * La prueba es una sola por marca: si ya se consumió, el alta se rechaza y la
   * marca solo puede volver por el checkout pago. En cambio, una suscripción
   * vencida o cancelada que nunca la usó sí puede iniciarla, reusando su fila.
   */
  async startTrial(input: {
    brandId: string
    userId: string
    planSlug: string
    provider?: SubscriptionProvider
    walletId?: string
  }) {
    const { brandId, userId, planSlug } = input

    const freePlan = process.env.FREE_PLAN_SLUG || 'free'
    if (!planSlug || planSlug === freePlan) {
      throw new RequestException(
        { code: 'INVALID_TRIAL_PLAN', message: 'El trial requiere un plan de pago válido' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    // CAMBIO DE CONTRATO RUIDOSO: el alta de trial pasa por ConfioPagos y ya no hay
    // medio que elegir (regla de negocio de la épica: «ConfioPagos es el único medio
    // de pago»). Se rechaza en vez de ignorar en silencio porque la alternativa es
    // peor: a un llamador que mandó `provider: 'wallet'` se le crearía igual una
    // suscripción REAL en el store de ConfioPagos, ignorando lo que pidió.
    if ((input.provider && input.provider !== SubscriptionProvider.CONFIO) || input.walletId) {
      throw new RequestException(
        {
          code: 'TRIAL_PROVIDER_NOT_SUPPORTED',
          message: 'El alta de la prueba se crea en ConfioPagos: no admite otro medio de pago ni wallet',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    // Se lee del repo de ESCRITURA porque a partir de acá el alta hace read-modify-write
    // sobre la fila (la reusa si el ciclo anterior está muerto) y la réplica podría estar
    // atrasada; `cancel()` y `reactivate()` ya usan el repo de escritura por lo mismo.
    // Esta lectura es sólo la guardia BARATA: corta el 99% de los rechazos antes de
    // gastar dos llamadas HTTP. La garantía es la relectura bajo lock de más abajo.
    // Deuda que NO se resuelve acá: `create()` y el checkout siguen creando
    // suscripciones sin pasar por este camino, así que esto es la barrera del alta,
    // no una invariante de dominio.
    const existing = await this.subscriptionRepository.findOne({ where: { brandId } })

    // Con servicio vigente no hay nada que iniciar: se conserva el código de siempre.
    if (existing && LIVE_SUBSCRIPTION_STATUSES.includes(existing.status)) {
      throw new RequestException(
        {
          code: 'SUBSCRIPTION_ALREADY_EXISTS',
          message: 'La marca ya tiene una suscripción vigente',
        },
        HttpStatus.CONFLICT,
      )
    }

    // El alta que quedó ESPERANDO la aceptación no es una prueba consumida ni una
    // suscripción vigente: es la misma alta, sin terminar. Va ANTES del guard de
    // `trialStart` a propósito —esa columna ya está sellada en la fila `pending`—
    // porque el orden decide qué código sale, y `TRIAL_ALREADY_USED` mandaría al
    // llamador al alta PAGA (`roax-suscription-modal.component.ts:404`), que reusa
    // la fila `pending` y crearía una SEGUNDA suscripción en ConfioPagos: dos
    // recurrencias vivas para la misma marca y el link inicial huérfano.
    // Lo que corresponde es retomar la que ya existe, y el camino es
    // `GET /subscription/acceptance-link`, que devuelve el link YA emitido.
    if (existing && existing.status === SubscriptionStatus.PENDING && existing.providerSubscriptionId) {
      throw new RequestException(
        {
          code: 'SUBSCRIPTION_PENDING_ACCEPTANCE',
          message: 'El alta ya está creada y espera que completes el registro del medio de pago',
        },
        HttpStatus.CONFLICT,
      )
    }

    // `trialStart` es la marca durable de prueba consumida: ningún camino la limpia
    // (la invariante completa, con el enumerado de escritores, vive al lado de la
    // columna en `subscription.entity.ts`). Los cierres de HOY, que son los que dejan
    // una fila terminal delante de este guard:
    //   · `cancel` apaga `autoRenew`, sella `cancelledAt` y `accessEndsAt`, y YA NO
    //     mueve el `status` — la fila sigue viva hasta que la cierre el cron.
    //   · `TasksService.expireCancelledSubscriptions` (cron horario) consume esa baja
    //     y la cierra en `cancelled`; `expireSubscriptions` y `endTrialWithoutPayment`
    //     la cierran en `expired`. Ninguno toca `trialStart`/`trialEnd`.
    //   · `checkout.createOrRenewSubscription` la revive en `active`, también sin
    //     tocarlas: recomprar no devuelve la prueba.
    // ⚠️ MATIZ OBSERVABLE del corte diferido: MIENTRAS la baja está PENDIENTE la fila
    // sigue viva (`trial`/`active`/`past_due`), así que gana el guard de vigencia de
    // arriba y el alta se rechaza con `SUBSCRIPTION_ALREADY_EXISTS` —también 409,
    // también sin segunda prueba—; recién cuando el cron la cierra este guard responde
    // `TRIAL_ALREADY_USED`. El orden es deliberado: con acceso pagado todavía vigente
    // lo cierto es que la marca YA tiene suscripción, no sólo que gastó su prueba.
    if (existing && existing.trialStart) {
      throw new RequestException(
        {
          code: 'TRIAL_ALREADY_USED',
          message: 'La marca ya usó su prueba gratuita; para volver a suscribirse hay que pagar el plan',
        },
        HttpStatus.CONFLICT,
      )
    }

    const trialDays = parseInt(process.env.TRIAL_DAYS || '15')
    const now = new Date()
    const trialEnd = new Date(now)
    trialEnd.setDate(trialEnd.getDate() + trialDays)

    try {
      // `correlationId` SÓLO cuando se reusa una fila muerta: ahí `existing.id` es
      // estable entre reintentos. Para una marca nueva no se pre-genera un uuid —cada
      // reintento dejaría en ConfioPagos un huérfano con un correlationId distinto que
      // ya no correlaciona con nada nuestro—, y tampoco hace falta: el webhook resuelve
      // primero por `providerSubscriptionId = data.name`, que siempre se persiste.
      const confioSub = await this.confioTrial.createForTrial({
        brandId,
        userId,
        planSlug,
        ...(existing ? { correlationId: existing.id } : {}),
        // La fila que se reusa puede tener una suscripción VIVA del otro lado: se
        // cancela antes de crear la nueva, o quedarían dos y la vieja podría cobrar.
        ...(nombreAnterior(existing) ? { reemplazaA: nombreAnterior(existing) } : {}),
      })

      // Acá NO se toca `backend-roles`, y es el punto de esta tarea: el alta no
      // reparte acceso. Lo otorga la CONFIRMACIÓN de ConfioPagos —el webhook
      // `TRIALING`, `confio-subscription-webhook.service.ts`—, que es cuando la
      // suscripción existe de verdad. Efecto colateral querido: una caída de roles
      // ya no puede abortar un alta que del otro lado YA quedó creada, así que el
      // modo de fallo `PLAN_ASSIGNMENT_FAILED` desaparece de este camino.

      const confioName = confioSub.providerSubscriptionId
      // El resource name de la suscripción CONTIENE el del plan
      // (`…/subscription-plans/{plan}/subscriptions/{sub}`): se guarda derivado en vez
      // de recomponerlo después. Si el separador NO está, el `split` devuelve la cadena
      // ENTERA y guardaría la suscripción disfrazada de plan: en ese caso, `null`.
      const confioPlanName = SubscriptionService.derivePlanName(confioName)

      const saved = await this.dataSource.transaction(async (manager) => {
        // Relectura bajo lock: entre la guardia barata y esta escritura pasaron dos
        // llamadas HTTP, o sea una ventana de segundos en la que otro request pudo
        // ganar. Precedente del `pessimistic_write` en `wallet.service.ts:104` y en
        // `confio-subscription-webhook.service.ts:296`.
        const current = await manager.findOne(Subscription, {
          where: { brandId },
          lock: { mode: 'pessimistic_write' },
        })

        // Los MISMOS dos guards, revalidados contra la fila lockeada: si otro request
        // ya inició la prueba, se rechaza en vez de pisarle el ciclo.
        if (current && LIVE_SUBSCRIPTION_STATUSES.includes(current.status)) {
          throw new RequestException(
            { code: 'SUBSCRIPTION_ALREADY_EXISTS', message: 'La marca ya tiene una suscripción vigente' },
            HttpStatus.CONFLICT,
          )
        }
        if (current && current.status === SubscriptionStatus.PENDING && current.providerSubscriptionId) {
          throw new RequestException(
            {
              code: 'SUBSCRIPTION_PENDING_ACCEPTANCE',
              message: 'El alta ya está creada y espera que completes el registro del medio de pago',
            },
            HttpStatus.CONFLICT,
          )
        }
        if (current && current.trialStart) {
          throw new RequestException(
            {
              code: 'TRIAL_ALREADY_USED',
              message: 'La marca ya usó su prueba gratuita; para volver a suscribirse hay que pagar el plan',
            },
            HttpStatus.CONFLICT,
          )
        }

        // Si la marca ya tenía una fila muerta se reusa (el índice único por brandId
        // impide una segunda) y se resetean los residuos del ciclo anterior.
        const subscription = this.subscriptionRepository.create({
          ...(current ? { id: current.id } : {}),
          brandId,
          userId,
          planSlug,
          // Esperando la confirmación, igual que el alta paga: `pending` es el único
          // estado que NO reparte acceso ni entra en ningún barrido que cobre
          // (`tasks.service.ts`, docblock del archivo). Pasa a `trial` cuando
          // ConfioPagos reporte `TRIALING`, o sea cuando el comprador aceptó.
          status: SubscriptionStatus.PENDING,
          // ⚠️ `provider = confio` + `nextBillingDate = trialEnd` cambian la rama del
          // cron: `processTrialConversions` (`tasks.service.ts:141`) ya NO puede tomar
          // `provider === 'wallet' && !walletId → endTrialWithoutPayment`, así que TODO
          // trial vencido cae en `issueExternalCharge`. Consecuencia aguas abajo: la
          // degradación a free deja de ser inmediata — la fila queda `past_due` con un
          // SEGUNDO link emitido y notificado, `retryFailedPayments` re-emite con
          // backoff 24/48/72h y recién con `retryCount >= MAX_RETRY` la degrada
          // `expireSubscriptions` (`tasks.service.ts:321`). O sea ~3 días extra de
          // `past_due` y 2-3 links/mails de más por marca que no aceptó. El acceso en
          // roles igual caduca en `trialEnd` por su `expiresAt`. Acá NO se toca
          // `tasks.service.ts`: eso es `cron-de-conversion-no-emite-segundo-link`.
          provider: SubscriptionProvider.CONFIO,
          walletId: null,
          providerSubscriptionId: confioName,
          currentPeriodStart: now,
          currentPeriodEnd: trialEnd,
          trialStart: now,
          trialEnd,
          // Se marca INCONDICIONALMENTE: lo que afirma no es «hubo URL» sino «esta fila ya
          // tiene su suscripción recurrente en ConfioPagos», y re-emitir un checkout
          // one-shot encima sería un segundo riel de cobro. Si el `acceptanceUrl` no llegó,
          // la vía de recuperación es `getAcceptanceLink`, nunca el cron. El reuso de una
          // fila muerta lo re-marca a propósito: ciclo nuevo, link nuevo.
          initialPaymentLinkIssuedAt: now,
          nextBillingDate: trialEnd,
          autoRenew: true,
          cancelledAt: null,
          cancelReason: null,
          // Invariante de la columna: no nula ⇔ hay una baja PENDIENTE. Un ciclo nuevo
          // no la tiene, y dejar la fecha del ciclo anterior mostraría un fin de acceso
          // sobre una suscripción que se renueva.
          accessEndsAt: null,
          retryCount: 0,
          lastPaymentId: null,
          // Se reescribe entera y a mano: NUNCA el `raw` de ConfioPagos (lleva `buyer`,
          // o sea email y teléfono) y NUNCA el `acceptanceUrl`, que es un link PORTADOR
          // —quien lo tenga registra una tarjeta contra esta suscripción—. El link se
          // re-pide por el camino autenticado con `getAcceptanceLink`.
          metadata: {
            confio: {
              name: confioName,
              status: confioSub.status,
              planName: confioPlanName,
              // La fila que se REUSA es la del lock, no la de la pre-guardia barata: en
              // la carrera (`existing` null y `current` una fila muerta) `existing?.id`
              // anotaría `null` para una fila que sí tiene id.
              correlationId: confioSub.correlationId ?? current?.id ?? null,
              acceptanceExpireTime: confioSub.acceptanceExpireTime
                ? confioSub.acceptanceExpireTime.toISOString()
                : null,
            },
          },
        })
        const row = await manager.save(Subscription, subscription)

        // La fila y su evento se escriben JUNTOS: un `TRIAL_STARTED` sin fila (o al
        // revés) rompe la traza que pide el criterio 2 de la épica.
        await manager.save(
          SubscriptionEvent,
          this.subscriptionEventRepository.create({
            subscriptionId: row.id,
            eventType: SubscriptionEventType.TRIAL_STARTED,
            toPlanSlug: planSlug,
            // Deja reconstruible el reinicio: la fila puede acumular más de un ciclo.
            fromStatus: current?.status ?? null,
            // El estado REAL al que llega la fila. Decir `trial` acá dejaría en el
            // historial una prueba que empezó, cuando lo que empezó es el alta.
            toStatus: SubscriptionStatus.PENDING,
            triggeredBy: userId,
            reason: `Alta de prueba de ${trialDays} días creada, esperando la aceptación`,
          }),
        )

        return row
      })

      // Después del commit y en su propio try/catch: un fallo del canal de avisos no
      // puede convertir un alta ya persistida en un `{ error }`.
      try {
        await this.eventBus.publishNotification({
          brandId,
          userId,
          type: 'trial_started',
          subject: `Tu prueba gratuita de ${trialDays} días ha comenzado`,
          metadata: { planSlug, trialEnd: trialEnd.toISOString() },
        })
      } catch (error) {
        // `error?.message` y no `error.message`: un rechazo que no es `Error` haría
        // explotar ESTE catch, la excepción subiría al `try` de afuera y degradaría a
        // `{ error }` un alta ya commiteada — justo lo que este aislamiento evita.
        this.logger.warn(`Trial ${saved.id} iniciado pero la notificación falló: ${error?.message}`)
      }

      this.logger.log(
        `Alta de prueba creada: ${saved.id} marca ${brandId} plan ${planSlug}, prueba hasta ` +
          `${trialEnd.toISOString()} si acepta ` +
          `(ConfioPagos ${confioName}, link de aceptación: ${confioSub.acceptanceUrl ? 'sí' : 'no'})`,
      )
      // El link viaja en la respuesta y en ningún otro lado: no se persiste ni se loguea.
      return {
        data: saved,
        acceptanceUrl: confioSub.acceptanceUrl,
        acceptanceExpireTime: confioSub.acceptanceExpireTime,
      }
    } catch (error) {
      // Marca nueva: no hay fila que lockear, así que la carrera la serializa el índice
      // único `@Index(['brandId'], { unique: true })` (`subscription.entity.ts:8`). El
      // perdedor recibe un 409, no un 500.
      if (isUniqueViolation(error)) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_ALREADY_EXISTS', message: 'La marca ya tiene una suscripción vigente' },
          HttpStatus.CONFLICT,
        )
      }
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al iniciar trial de marca ${brandId}: ${error?.message}`)
      // NO se devuelve `{ error }` con 200. El contrato entero de este endpoint es
      // devolver el `acceptanceUrl`: un 200 sin él es indistinguible de un éxito para
      // un front que lee `res.acceptanceUrl`, y acá abajo caen fallos posteriores al
      // `POST` a ConfioPagos (la escritura de la fila, el commit), o sea justo los
      // casos en los que el llamador TIENE que enterarse. El detalle interno no se
      // reexpone: queda en el log de arriba.
      throw new RequestException(
        {
          code: 'TRIAL_START_FAILED',
          message: 'No se pudo iniciar la prueba gratuita, reintentá en unos minutos',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
  }


  /**
   * ALTA PAGA, sin prueba: la vuelta de la marca que ya consumió su trial.
   *
   * Es el destino del CTA de «volver a suscribirse»: `POST /subscription/trial` le
   * responde 409 `TRIAL_ALREADY_USED` a quien ya la gastó, y `POST /subscription/reactivate`
   * rechaza a propósito las filas de ConfioPagos («la vuelta es un alta nueva»). Hasta
   * acá no había ninguna puerta para volver a pagar.
   *
   * Del lado de ConfioPagos es EXACTAMENTE la misma alta que la de la prueba —su API no
   * distingue: `createSubscription({planName, buyer})` no tiene parámetro de trial—; la
   * prueba es un concepto NUESTRO (`trialStart`/`trialEnd` + los 15 días). Por eso reusa
   * `ConfioTrialService`, cuyo nombre habla del llamador original y no de lo que hace.
   *
   * Las dos diferencias con `startTrial`, y son las que definen esta tarea:
   *   · la fila nace en `PENDING`, no en `TRIAL`: no hay período abierto ni acceso, y el
   *     estado se mueve recién cuando ConfioPagos confirme el primer cobro;
   *   · NO se asigna plan en roles. El trial lo hace desde el alta porque la prueba
   *     empieza ahí; acá no hay nada que regalar y el acceso lo abre el webhook
   *     (`confio-subscription-webhook.service.ts`), que sobre una fila `pending` —que NO
   *     es terminal— sí repone el plan.
   */
  async startPaid(input: { brandId: string; userId: string; planSlug: string }) {
    const { brandId, userId, planSlug } = input

    // Mismo rechazo que el alta de prueba y por lo mismo: sin plan pago no hay nada que
    // crear en ConfioPagos. Código propio para que el llamador no lea «trial» en la
    // respuesta de un endpoint que no lo tiene.
    const freePlan = process.env.FREE_PLAN_SLUG || 'free'
    if (!planSlug || planSlug === freePlan) {
      throw new RequestException(
        { code: 'INVALID_PAID_PLAN', message: 'El alta paga requiere un plan de pago válido' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    // Guardia BARATA contra el repo de ESCRITURA, igual que `startTrial`: corta antes de
    // gastar la llamada HTTP, y la garantía la da la relectura bajo lock de más abajo.
    const existing = await this.subscriptionRepository.findOne({ where: { brandId } })

    if (existing && LIVE_SUBSCRIPTION_STATUSES.includes(existing.status)) {
      throw new RequestException(
        { code: 'SUBSCRIPTION_ALREADY_EXISTS', message: 'La marca ya tiene una suscripción vigente' },
        HttpStatus.CONFLICT,
      )
    }

    // NO hay guard de `trialStart`: este endpoint existe justamente para la marca que ya
    // gastó su prueba. Y una fila `pending` TAMPOCO bloquea —no está en
    // `LIVE_SUBSCRIPTION_STATUSES`—: se REUSA. Es la conducta que fijó
    // `estado-pending-en-suscripciones` y que su test cierra («una fila `pending` no
    // bloquea el alta: la reusa en vez de responder 409»). Rechazar acá dejaría encerrada
    // a la marca que abandonó su link, porque `PENDING_ACCEPTANCE` está en
    // `CONFIO_ESTADOS_SIN_EFECTO`: ningún webhook ni cron mueve esa fila.

    try {
      const confioSub = await this.confioTrial.createForTrial({
        brandId,
        userId,
        planSlug,
        // `correlationId` sólo con fila muerta que reusar, mismo criterio que el trial.
        ...(existing ? { correlationId: existing.id } : {}),
        // Y el mismo reemplazo: acá la fila reusada puede ser una `pending` con su link
        // todavía vivo, así que la de allá se cancela igual antes de crear la nueva.
        ...(nombreAnterior(existing) ? { reemplazaA: nombreAnterior(existing) } : {}),
      })

      const confioName = confioSub.providerSubscriptionId
      const confioPlanName = SubscriptionService.derivePlanName(confioName)
      const now = new Date()

      const saved = await this.dataSource.transaction(async (manager) => {
        const current = await manager.findOne(Subscription, {
          where: { brandId },
          lock: { mode: 'pessimistic_write' },
        })

        // El MISMO guard, revalidado contra la fila lockeada: entre la guardia barata y
        // esta escritura pasó una llamada HTTP.
        if (current && LIVE_SUBSCRIPTION_STATUSES.includes(current.status)) {
          throw new RequestException(
            { code: 'SUBSCRIPTION_ALREADY_EXISTS', message: 'La marca ya tiene una suscripción vigente' },
            HttpStatus.CONFLICT,
          )
        }

        const subscription = this.subscriptionRepository.create({
          ...(current ? { id: current.id } : {}),
          brandId,
          userId,
          planSlug,
          status: SubscriptionStatus.PENDING,
          provider: SubscriptionProvider.CONFIO,
          walletId: null,
          providerSubscriptionId: confioName,
          // NO hay período todavía: el ciclo lo abre el primer cobro. Las dos columnas son
          // NOT NULL, así que se sellan en `now` —un período de largo cero, que es lo
          // honesto— y el webhook las reescribe: `periodoLocal` toma el fin anterior sólo
          // si está en el FUTURO y si no pone piso en el ahora, así que este valor no se
          // filtra a la fecha de acceso ni a `nextBillingDate`.
          currentPeriodStart: now,
          currentPeriodEnd: now,
          // `trialStart` y `trialEnd` NO se listan A PROPÓSITO: omitirlos deja intactos los
          // que la fila ya tenga. Escribirlos en `null` acá le devolvería la prueba gratis
          // a la marca que la gastó, que es exactamente lo que este endpoint viene a cobrar.
          initialPaymentLinkIssuedAt: now,
          // Nada agendado de nuestro lado: la recurrencia la arranca ConfioPagos cuando el
          // comprador acepta. Un `nextBillingDate` puesto acá despertaría a
          // `processSubscriptionRenewals` sobre una fila que todavía no pagó nada.
          nextBillingDate: null,
          autoRenew: true,
          // Residuos del ciclo anterior, reseteados como en el alta de prueba: la fila que
          // se reusa viene de una baja o de un vencimiento.
          cancelledAt: null,
          cancelReason: null,
          accessEndsAt: null,
          retryCount: 0,
          lastPaymentId: null,
          metadata: {
            confio: {
              name: confioName,
              status: confioSub.status,
              planName: confioPlanName,
              correlationId: confioSub.correlationId ?? current?.id ?? null,
              acceptanceExpireTime: confioSub.acceptanceExpireTime
                ? confioSub.acceptanceExpireTime.toISOString()
                : null,
            },
          },
        })
        const row = await manager.save(Subscription, subscription)

        // La fila y su traza, juntas. `CREATED` y no `TRIAL_STARTED`: acá no empieza
        // ninguna prueba, y el enum de Postgres no admite un valor que no exista.
        await manager.save(
          SubscriptionEvent,
          this.subscriptionEventRepository.create({
            subscriptionId: row.id,
            eventType: SubscriptionEventType.CREATED,
            toPlanSlug: planSlug,
            fromStatus: current?.status ?? null,
            toStatus: SubscriptionStatus.PENDING,
            triggeredBy: userId,
            reason: 'Alta paga sin prueba: link de aceptación emitido',
          }),
        )

        return row
      })

      this.logger.log(
        `Alta paga creada: ${saved.id} marca ${brandId} plan ${planSlug} en estado pending ` +
          `(ConfioPagos ${confioName}, link de aceptación: ${confioSub.acceptanceUrl ? 'sí' : 'no'})`,
      )
      // El link viaja en la respuesta y en ningún otro lado: es PORTADOR, no se persiste
      // ni se loguea. Se re-pide con `getAcceptanceLink`.
      return {
        data: saved,
        acceptanceUrl: confioSub.acceptanceUrl,
        acceptanceExpireTime: confioSub.acceptanceExpireTime,
      }
    } catch (error) {
      // Marca sin fila previa: la carrera la serializa el índice único por `brandId`, y el
      // perdedor recibe 409 y no 500.
      if (isUniqueViolation(error)) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_ALREADY_EXISTS', message: 'La marca ya tiene una suscripción vigente' },
          HttpStatus.CONFLICT,
        )
      }
      if (error instanceof RequestException) throw error
      this.logger.error(`Error en el alta paga de marca ${brandId}: ${error?.message}`)
      // Mismo criterio que el alta de prueba: NUNCA un 200 sin `acceptanceUrl`, que un
      // front que lee `res.acceptanceUrl` no puede distinguir de un éxito.
      throw new RequestException(
        { code: 'PAID_START_FAILED', message: 'No se pudo crear la suscripción, reintentá en unos minutos' },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
  }

  /**
   * Deriva el resource name del PLAN a partir del de la suscripción
   * (`…/subscription-plans/{plan}/subscriptions/{sub}`).
   *
   * Devuelve `null` cuando el separador no aparece: `split` sobre una cadena que no
   * lo contiene devuelve la cadena ENTERA, y guardarla como `planName` dejaría en
   * metadata una suscripción disfrazada de plan, que además pasa cualquier chequeo
   * de "no es nulo".
   */
  private static derivePlanName(confioName?: string): string | null {
    const name = String(confioName || '')
    const at = name.indexOf('/subscriptions/')
    return at > 0 ? name.slice(0, at) : null
  }

  /**
   * Re-pedir el link de aceptación de la suscripción de una marca.
   *
   * La ruta HTTP ya existe: `GET /subscription/acceptance-link`
   * (`subscription.controller.ts`). El `acceptanceUrl` es un link PORTADOR
   * (`confio.types.ts:158`) y este controller sigue siendo autenticación SOLA, sin
   * ningún `@RequirePermission`, así que el reparo que este bloque advertía —que
   * cualquier usuario autenticado pidiera el link de cualquier marca— quedó acotado
   * por dónde sale el `brandId`, no por un permiso: `resolveBrandId` le entrega al
   * principal usuario SU propia marca (`req.user.brand`) e ignora el query, y sólo
   * el principal de servicio (`ACCESS_SERVER` / superadmin) puede nombrar una marca
   * ajena. Un usuario ya no puede pedir el link de una marca que no es la suya.
   *
   * Lo que NO cubre esa regla: `req.user.brand` es un claim del token, no una
   * verificación de pertenencia contra backend-platform (ver la deuda anotada en
   * `resolveBrandId`), y el principal de servicio sigue siendo confianza total.
   */
  async getAcceptanceLink(brandId: string) {
    const subscription = await this.subscriptionReadRepository.findOne({ where: { brandId } })
    if (!subscription) {
      throw new RequestException(
        { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
        HttpStatus.NOT_FOUND,
      )
    }

    // `metadata.confio.name` es la fuente principal; `providerSubscriptionId` es el
    // mismo valor y queda de respaldo para las filas que escribió otro camino.
    const name = subscription.metadata?.confio?.name ?? subscription.providerSubscriptionId
    if (!name) {
      throw new RequestException(
        {
          code: 'NO_CONFIO_SUBSCRIPTION',
          message: 'La suscripción de la marca no tiene una suscripción en ConfioPagos asociada',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    return { data: await this.confioTrial.fetchAcceptance(name) }
  }

  /**
   * Confirmar contra ConfioPagos, sin esperar su notificación.
   *
   * Es la vía que hace que el estado NO dependa del webhook (regla de la épica 002
   * desde el 2026-09-02): el front la llama al volver del pago y el barrido de
   * repesca la usa para quien nunca vuelve.
   *
   * La regla de qué se otorga y con qué vencimiento NO vive acá: la aplica
   * `ConfioSubscriptionWebhookService.confirmarContraElProveedor`, o sea el MISMO
   * planificador y la misma escritura que el webhook. Este método sólo resuelve de
   * qué fila se habla y traduce el desenlace a HTTP.
   *
   * `sin_confirmar` NO es un error: es lo que pasa mientras el comprador no completó
   * el pago, y es la respuesta que el front sondea. El fallo del canal sí lo es, y va
   * separado: confundirlos haría que una caída de ConfioPagos se le contara al
   * usuario como «no pagaste».
   */
  async confirm(brandId: string) {
    const subscription = await this.subscriptionRepository.findOne({ where: { brandId } })
    if (!subscription) {
      throw new RequestException(
        { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
        HttpStatus.NOT_FOUND,
      )
    }

    const { resultado, estadoRemoto } = await this.confioWebhook.confirmarContraElProveedor(
      subscription,
    )

    if (resultado === 'proveedor_no_disponible') {
      throw new RequestException(
        {
          code: 'CONFIO_STATUS_UNAVAILABLE',
          message: 'No se pudo consultar el estado en ConfioPagos, reintentá en unos minutos',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }

    if (resultado === 'sin_suscripcion_en_el_proveedor') {
      throw new RequestException(
        {
          code: 'NO_CONFIO_SUBSCRIPTION',
          message: 'La suscripción de la marca no tiene una suscripción en ConfioPagos asociada',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    // Se relee DESPUÉS de aplicar: el llamador necesita la fila como quedó, no como
    // estaba. `data` es la misma forma que devuelve `getCurrent`, así que el front no
    // aprende un segundo formato.
    const actual = await this.subscriptionRepository.findOne({ where: { brandId } })

    return { data: actual, confirmed: resultado !== 'sin_confirmar', providerStatus: estadoRemoto }
  }

  /**
   * Obtener la suscripción actual de una marca
   */
  async getCurrent(brandId: string) {
    try {
      const subscription = await this.subscriptionReadRepository.findOne({
        where: { brandId },
      })
      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }
      return { data: subscription }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al obtener suscripción de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Crear una suscripción nueva
   */
  async create(data: Partial<Subscription>) {
    try {
      const subscription = this.subscriptionRepository.create(data)
      const saved = await this.subscriptionRepository.save(subscription)

      // Registrar evento de creación
      await this.subscriptionEventRepository.save(
        this.subscriptionEventRepository.create({
          subscriptionId: saved.id,
          eventType: SubscriptionEventType.CREATED,
          toPlanSlug: saved.planSlug,
          toStatus: saved.status,
          triggeredBy: saved.userId,
        }),
      )

      this.logger.log(`Suscripción creada: ${saved.id} para marca ${saved.brandId}`)
      return { data: saved }
    } catch (error) {
      this.logger.error(`Error al crear suscripción: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Cambiar de plan
   */
  async changePlan(brandId: string, newPlan: { planSlug: string; triggeredBy: string }) {
    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()

    try {
      const subscription = await queryRunner.manager.findOne(Subscription, {
        where: { brandId },
      })

      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      const fromPlan = subscription.planSlug
      subscription.planSlug = newPlan.planSlug
      await queryRunner.manager.save(Subscription, subscription)

      // Registrar evento de cambio de plan
      await queryRunner.manager.save(SubscriptionEvent, {
        subscriptionId: subscription.id,
        eventType: SubscriptionEventType.PLAN_CHANGED,
        fromPlanSlug: fromPlan,
        toPlanSlug: newPlan.planSlug,
        triggeredBy: newPlan.triggeredBy,
      })

      await queryRunner.commitTransaction()
      this.logger.log(`Plan cambiado de ${fromPlan} a ${newPlan.planSlug} para marca ${brandId}`)
      return { data: subscription }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al cambiar plan de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    } finally {
      await queryRunner.release()
    }
  }

  /**
   * Hasta cuándo llega el acceso YA pagado de una fila a la que se le pide la baja.
   *
   * En trial es `trialEnd` y no `currentPeriodEnd`: el alta abre el período contra el
   * fin de la prueba, pero son dos campos distintos y tomar el equivocado regalaría
   * (o cortaría) días. Fuera del trial es el cierre del período que la marca pagó.
   *
   * Sin NINGUNA de las dos fechas el acceso termina AHORA: no se puede acotar un
   * período que no existe y regalarlo sería peor que cortarlo — la fila queda
   * inmediatamente elegible para el cron de retiro, que es el comportamiento seguro.
   */
  private static finDeAcceso(fila: Subscription): Date {
    const fin =
      fila.status === SubscriptionStatus.TRIAL
        ? (fila.trialEnd ?? fila.currentPeriodEnd)
        : fila.currentPeriodEnd
    return fin ?? new Date()
  }

  /**
   * Cancelar la suscripción: primero en ConfioPagos, después acá.
   *
   * ORDEN, que es la invariante de esta tarea: **la pasarela primero, la
   * escritura después**. El HTTP 200 de ConfioPagos ES la confirmación (su
   * respuesta viene vacía), y recién con esa confirmación se sella la fila. Si
   * ellos rechazan, la `RequestException` sube tal cual y NO se escribe nada:
   * jamás se marca como cancelado algo que del otro lado sigue cobrando
   * (restricción 1 de la aceptación — mismo criterio que el alta, que tampoco
   * persiste nada antes del POST).
   *
   * ⚠️ REPARACIÓN sí, REPETICIÓN no. La cancelación de ConfioPagos es IDEMPOTENTE
   * (cancelar dos veces responde 200, medido contra dev el 2026-08-27), así que
   * una fila terminal SIN su `SubscriptionEvent` —el camino de reparación de la
   * restricción 5— vuelve a pasar por el mismo código y esta vez sí deja la
   * traza. Pero una fila YA sellada (`cancelledAt`) y CON su traza no se
   * reescribe: el doble click o el reintento del cliente tras un 200 perdido
   * duplicaba el `SubscriptionEvent` de UNA sola transición y pisaba el
   * `cancelReason` original con el motivo del reintento. Ni el `cancelledAt` ni
   * el `cancelReason` se re-sellan: los dos describen el MISMO hecho y el hecho
   * es el primero, igual que hace el webhook
   * (`confio-subscription-webhook.service.ts`).
   *
   * ⚠️ Una fila `confio` SIN resource name (`metadata.confio.name` y
   * `providerSubscriptionId` en null) NUNCA tuvo suscripción del otro lado: sólo
   * `startTrial` escribe ese dato, y el checkout (`checkout.service.ts`) marca
   * `provider = confio` sin tocarlo. Esas filas se cancelan LOCAL, con la traza
   * diciendo `confirmadoPorConfio: false`. No es una excepción a la restricción 1
   * —no hay nada allá que confirmar— y es lo único que las saca del cron horario
   * de re-emisión de cobro (`tasks.service.ts`, filtra por `autoRenew`). Distinto
   * es un name PRESENTE pero corrupto o de otro store: ahí sí 503 con cero
   * escrituras, porque del otro lado puede haber una suscripción cobrando.
   *
   * ⚠️ RESIDUAL ACEPTADO, y en una sola dirección: si ConfioPagos confirma y la
   * escritura local falla, la fila queda viva acá mientras allá ya no se cobra —
   * el llamador recibe un 503 y el reintento se auto-repara, justamente porque su
   * cancelación es idempotente. La inversa (afirmar una baja que ellos no
   * confirmaron) es imposible por construcción.
   *
   * ⚠️ El marcador de «confirmado» NO va en `metadata`: es la columna
   * `cancelledAt` —el mismo lugar que sella el webhook— más el
   * `SubscriptionEvent` CANCELLED, escritos en la MISMA transacción que el estado.
   *
   * ── EL CORTE DE ACCESO ES DIFERIDO ──────────────────────────────────────────
   *
   * Esto ya NO retira el plan de roles ni mueve la fila a `cancelled`: la baja es un
   * apagado de RENOVACIÓN. Se sella `autoRenew = false` + `cancelledAt` +
   * `accessEndsAt`, y la marca sigue con su plan hasta esa fecha —que es lo que ya
   * pagó—.
   *
   * Lo que se difiere es el CORTE LOCAL, no el cobro: la baja en ConfioPagos sigue
   * siendo inmediata e irreversible (y sigue siendo lo primero que pasa, ver arriba).
   *
   * ⚠️ QUIÉN EJECUTA EL RETIRO: el cron horario
   * `TasksService.expireCancelledSubscriptions`, que barre por el par
   * `autoRenew = false` + `accessEndsAt` pasado, degrada a `free` en roles y sólo si
   * roles acepta cierra la fila en `cancelled`. Hasta esa hora el acceso lo sigue
   * sosteniendo el `expiresAt` que roles ya tenía del alta, que coincide con
   * `accessEndsAt` por construcción; el corte con nombre y traza es el del cron.
   *
   * ⚠️ Cancelar con el período YA vencido tampoco retira acá: la fila queda con
   * `accessEndsAt` en el pasado y la tomará la primera pasada del cron (a lo sumo,
   * una hora). Hacerlo inline exigiría `downgradeBrandToFree` —`removePlanFromBrand` a secas dejaría a la
   * marca SIN NINGÚN plan, ver `plan-downgrade.util.ts`— y pondría un segundo dueño
   * sobre la misma degradación, además de reintroducir una llamada HTTP post-commit
   * que puede fallar a medias.
   *
   * El eco de esta baja por webhook está NEUTRALIZADO: ConfioPagos emite
   * `subscription.subscriptionStatusChanged` con `CANCELED` detrás nuestro, y
   * `confio-subscription-webhook.service.ts` lo descarta sin efecto mientras
   * `cancelledAt` esté sellado y `accessEndsAt` siga en el futuro (`bajaPendiente`).
   * Sin esa guarda ese camino degradaba a `free` segundos después de que esto
   * conservó el plan, y era el camino de la MAYORÍA de las bajas.
   */
  async cancel(brandId: string, reason: { reason: string; triggeredBy: string }) {
    // Chequeos de DOMINIO, TODOS antes de la llamada IRREVERSIBLE a la pasarela.
    // El borde del provider tiene el suyo (`missing_cancel_reason`), pero llegar
    // hasta allá para descubrir que falta el motivo sería gastar una llamada HTTP
    // en un rechazo que se ve desde acá; y lo que valida la ESCRITURA posterior
    // tiene que estar acá sí o sí (ver `triggeredBy`).
    const motivo = String(reason?.reason || '').trim()
    if (!motivo) {
      throw new RequestException(
        {
          code: 'CANCEL_REASON_REQUIRED',
          message: 'ConfioPagos exige un motivo para cancelar la suscripción',
          field: 'reason',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    if (motivo.length > MAX_CANCEL_REASON_LENGTH) {
      throw new RequestException(
        {
          code: 'CANCEL_REASON_TOO_LONG',
          message: `El motivo no puede superar los ${MAX_CANCEL_REASON_LENGTH} caracteres`,
          field: 'reason',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    // `triggeredBy` se valida ACÁ, antes del POST, y no es cosmética: es
    // `varchar NOT NULL` en `subscription_events` y el body de este endpoint NO
    // pasa por un DTO (`@Body() data: { … }` es un tipo inline, sin metatype: el
    // `ValidationPipe({whitelist, forbidNonWhitelisted})` de `main.ts` no puede
    // chequearlo, tal como ya documenta `checkout.controller.ts`). Sin esta
    // guarda un body sin `triggeredBy` cancelaba DE VERDAD en ConfioPagos y
    // recién después moría la transacción con un 23502: cancelada allá, viva
    // acá, y el reintento muriendo igual para siempre —el único 503 de este
    // camino que NO se auto-repara.
    const triggeredBy = String(reason?.triggeredBy || '').trim()
    if (!triggeredBy) {
      throw new RequestException(
        {
          code: 'CANCEL_TRIGGERED_BY_REQUIRED',
          message: 'Falta indicar quién origina la baja',
          field: 'triggeredBy',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    if (triggeredBy.length > MAX_TRIGGERED_BY_LENGTH) {
      throw new RequestException(
        {
          code: 'CANCEL_TRIGGERED_BY_TOO_LONG',
          message: `El origen de la baja no puede superar los ${MAX_TRIGGERED_BY_LENGTH} caracteres`,
          field: 'triggeredBy',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    // Repo de ESCRITURA: a partir de acá esto es read-modify-write y la réplica
    // puede venir atrasada. Es también la lectura que resuelve el `name`.
    const subscription = await this.subscriptionRepository.findOne({ where: { brandId } })
    if (!subscription) {
      throw new RequestException(
        { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
        HttpStatus.NOT_FOUND,
      )
    }

    const esConfio = subscription.provider === SubscriptionProvider.CONFIO
    // Mismo orden de resolución que `getAcceptanceLink`, pero quedándose con el
    // PRIMER valor no vacío: un `metadata.confio.name` en `''` no puede tapar un
    // `providerSubscriptionId` bueno y mandar la fila al camino local. `metadata`
    // es jsonb SIN tipar, así que un valor que no es string cuenta como PRESENTE
    // (o sea corrupto) y se va al borde del provider, que lo rechaza con
    // `invalid_subscription_name` → 503 y cero escrituras.
    const confioName =
      [subscription.metadata?.confio?.name, subscription.providerSubscriptionId]
        .map((valor) => (typeof valor === 'string' ? valor.trim() : valor))
        .find((valor) => valor !== null && valor !== undefined && valor !== '') ?? null

    // Se habla con la pasarela sólo si hay a quién: sin `name` nunca hubo
    // suscripción allá (ver el docblock) y la baja es puramente local.
    const confirmadoPorConfio = esConfio && confioName !== null
    if (esConfio && !confirmadoPorConfio) {
      this.logger.warn(
        `Suscripción de marca ${brandId} marcada como confio SIN resource name: ` +
          'se cancela local, no hay suscripción que cancelar en ConfioPagos',
      )
    }

    try {
      if (confirmadoPorConfio) {
        // Fuera de la transacción: es HTTP y adentro retendría el lock de la fila.
        await this.confioCancellation.cancel(confioName, motivo)
      }

      const { row: saved } = await this.dataSource.transaction(async (manager) => {
        // Relectura bajo lock, mismo precedente que `startTrial` y que
        // `ConfioSubscriptionWebhookService.aplicar`: entre la lectura de arriba y
        // esta escritura hubo una llamada HTTP, o sea una ventana de segundos.
        const current = await manager.findOne(Subscription, {
          where: { brandId },
          lock: { mode: 'pessimistic_write' },
        })
        // Si la fila desapareció en esa ventana NO se cae al objeto detached de la
        // pre-lectura: `manager.save` lo RE-INSERTARÍA, resucitando datos borrados.
        // Mismo criterio que `aplicar`, que ante la fila ausente corta.
        if (!current) {
          throw new RequestException(
            { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
            HttpStatus.NOT_FOUND,
          )
        }

        // IDEMPOTENCIA. Una fila ya sellada y CON su traza describe una baja YA
        // registrada: el segundo click —o el reintento del cliente tras un 200
        // perdido— no agrega otro `SubscriptionEvent` para la MISMA transición ni
        // reescribe el motivo original. Si falta la traza —la fila que hay que
        // reparar (restricción 5)— esto da `false` y el evento se escribe igual.
        const yaRegistrada =
          !!current.cancelledAt &&
          (await manager.exists(SubscriptionEvent, {
            where: { subscriptionId: current.id, eventType: SubscriptionEventType.CANCELLED },
          }))

        // El estado vigente NO se toca: la baja apaga la renovación, no el acceso.
        // La fila sigue en `trial`/`active`/`past_due` hasta que el cron de retiro la
        // degrade, así que `fromStatus` y `toStatus` de la traza son el MISMO valor.
        const estadoVigente = current.status
        // Se SELLA una sola vez, como el webhook: la fecha de la baja es la
        // primera, no la del reintento que reparó la traza. El motivo va con el
        // MISMO criterio —describe el mismo hecho— y por eso tampoco se pisa. El
        // fin de acceso sigue la misma regla: moverlo en el segundo click regalaría
        // período sobre una baja ya tomada.
        if (!current.cancelledAt) current.cancelledAt = new Date()
        // Sólo las filas VIVAS ganan fecha de corte. Un ciclo ya cerrado
        // (`cancelled`/`expired`, el camino de REPARACIÓN de más arriba) no tiene
        // acceso que preservar: `finDeAcceso` le devolvería su `currentPeriodEnd`,
        // que en una fila cancelada a mitad de período está en el FUTURO, y la
        // columna quedaría no nula sobre una fila terminal — exactamente lo que la
        // invariante prohíbe («no nula ⇔ baja PENDIENTE») y lo que haría que el cron
        // de retiro la degradara una SEGUNDA vez.
        //
        // ⚠️ DEUDA VERIFICADA, del productor `alta-paga-sin-prueba` — y el predicado
        // que hay que arreglar es ÉSTE. `pending` no es terminal, así que una baja
        // sobre una fila `pending` entra por acá y le SELLA la fecha de corte; después
        // ningún cron la consume: `expireCancelledSubscriptions` enumera
        // `TRIAL`/`ACTIVE`/`PAST_DUE` (`tasks.service.ts`) y no la ve. La fila queda
        // con la marca de baja PENDIENTE para siempre, violando en la práctica la
        // invariante de acá arriba. El día que algo escriba `pending`, este guard pasa
        // a enumerar `LIVE_SUBSCRIPTION_STATUSES` en positivo —el mismo movimiento que
        // ya se hizo en `TasksService.reponerPlanSiSigueVigente`— en vez de negar el
        // conjunto terminal, que desde `pending` dejó de ser su complemento.
        if (!current.accessEndsAt && !TERMINAL_SUBSCRIPTION_STATUSES.includes(current.status)) {
          current.accessEndsAt = SubscriptionService.finDeAcceso(current)
        }
        if (!yaRegistrada) current.cancelReason = motivo
        current.autoRenew = false
        const row = await manager.save(Subscription, current)

        if (!yaRegistrada) {
          // La fila y su traza se escriben JUNTAS: un estado terminal sin
          // `SubscriptionEvent` es justamente la fila que hay que reparar.
          await manager.save(
            SubscriptionEvent,
            this.subscriptionEventRepository.create({
              subscriptionId: current.id,
              // Sigue siendo CANCELLED: es el hecho de negocio (la baja) y es lo que
              // `metrics.service.ts` cuenta como churn. Lo que cambió es que ya no
              // describe una transición de estado, y por eso los dos son iguales.
              eventType: SubscriptionEventType.CANCELLED,
              fromStatus: estadoVigente,
              toStatus: estadoVigente,
              triggeredBy,
              reason: motivo,
              // Forma espejo de `armarTrazaDelMovimiento`, escrita inline porque ese
              // helper es del webhook y estampa `triggeredBy: 'confio-webhook'`.
              // NUNCA lleva `providerEventId`: esa clave es el predicado de
              // idempotencia del webhook y escribirla acá haría que una notificación
              // posterior se creyera ya aplicada.
              metadata: {
                event: 'subscription.cancel',
                brandId,
                userId: current.userId,
                planSlug: current.planSlug,
                // Qué respalda esta baja: el 200 de ConfioPagos, o sólo nosotros.
                confirmadoPorConfio,
                ...(confirmadoPorConfio ? { providerRef: { name: confioName } } : {}),
                // Qué se apagó y hasta cuándo dura lo ya pagado: sin esto la traza no
                // permite reconstruir por qué la marca siguió con plan después de la baja.
                renovacionApagada: true,
                // La clave falta cuando no hay acceso que datar (fila terminal): la
                // traza describe lo que pasó, no completa un hueco con `null`.
                ...(current.accessEndsAt
                  ? { accessEndsAt: current.accessEndsAt.toISOString() }
                  : {}),
              },
            }),
          )
        }

        // La fila releída bajo lock es la única versión que la transacción vio.
        return { row }
      })

      // Un solo criterio para la columna en todo el método: o hay fecha de corte (y
      // es un `Date`), o la fila era terminal y no hay acceso que reportar.
      const hasta = saved.accessEndsAt ? saved.accessEndsAt.toISOString() : 'un ciclo ya cerrado'
      this.logger.log(
        `Renovación apagada para marca ${brandId}, acceso hasta ${hasta}` +
          (confirmadoPorConfio ? ` (confirmada por ConfioPagos ${confioName})` : ''),
      )
      return { data: saved }
    } catch (error) {
      // Los rechazos de la pasarela ya vienen con su código y su status: suben
      // tal cual, con cero escrituras detrás.
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al cancelar suscripción de marca ${brandId}: ${error?.message}`)
      // NO se devuelve `{ error }` con 200: acá caen los fallos POSTERIORES a la
      // confirmación de ConfioPagos, o sea justo los casos en los que el llamador
      // tiene que reintentar (y puede: su cancelación es idempotente). El detalle
      // interno queda en el log de arriba.
      throw new RequestException(
        {
          code: 'SUBSCRIPTION_CANCEL_FAILED',
          message: 'No se pudo registrar la cancelación, reintentá en unos minutos',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
  }

  /**
   * Deshacer la baja: la suscripción vuelve a renovarse.
   *
   * EL PREDICADO ES EL SELLO, NO EL ESTADO. Desde el corte diferido `cancel` ya no
   * escribe `status = cancelled`: la fila se queda en `trial`/`active`/`past_due`
   * mientras le debamos el acceso pagado. Gatear esto por `status === CANCELLED`
   * —como hacía— dejaba el endpoint respondiendo 422 SUBSCRIPTION_NOT_CANCELLED
   * durante TODA la ventana de gracia, que es justo el período en el que
   * arrepentirse tiene sentido. La marca de «esta fila está dada de baja» es
   * `cancelledAt`, la misma que sella el webhook.
   *
   * ⚠️ DINERO — SÓLO ENTRA UNA BAJA PENDIENTE. Un ciclo ya cerrado
   * (`cancelled`/`expired`) NO se revive por acá, y desde el cron horario
   * `TasksService.expireCancelledSubscriptions` eso dejó de ser un caso raro: ese
   * cron es el final de TODA baja no-confio, y cierra la fila dejándole el
   * `cancelledAt` sellado. Sin el gate de estado, el sello —que es lo que este
   * endpoint mira— alcanzaba para devolver a `active` una fila que el cron acababa
   * de degradar a `free` en backend-roles: suscripción viva, SIN pago, sobre una
   * marca sin plan pago, y encima elegible otra vez para
   * `processSubscriptionRenewals`, que para `provider = wallet` DEBITA. El endpoint
   * es sólo-autenticado y el `brandId` viaja en el body, así que cualquier llamador
   * podía dispararlo sobre cualquier marca cerrada. La vuelta es un alta nueva por
   * checkout, detrás de un `Payment` real.
   */
  async reactivate(brandId: string, triggeredBy: string) {
    try {
      const subscription = await this.subscriptionRepository.findOne({ where: { brandId } })
      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      if (!subscription.cancelledAt) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_CANCELLED', message: 'Solo se pueden reactivar suscripciones canceladas' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      // El acceso pagado YA se consumió: la fila la cerró un cron —o el webhook— que
      // antes de escribir el estado terminal degradó la marca a `free` en
      // backend-roles. Revivirla acá no repone ese plan y no cobra nada. Va ANTES
      // del gate de proveedor a propósito: es el gate de seguridad y no depende de
      // quién cobre.
      if (TERMINAL_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
        throw new RequestException(
          {
            code: 'SUBSCRIPTION_CLOSED',
            message: 'El acceso ya venció: la vuelta es un alta nueva por checkout',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      // Hasta hoy esto daba igual: `cancelSubscription` era un no-op, así que una
      // fila `confio` "cancelada" seguía viva del otro lado y reactivarla acá sólo
      // re-sincronizaba. Con la cancelación REAL ya no: allá quedó `CANCELED` y no
      // hay nada que pueda volver a cobrar. Y este endpoint recibe sólo
      // `{brandId, triggeredBy}` y revive la fila SIN pago —a diferencia de
      // `checkout.service.ts` (`createOrRenewSubscription`), que sólo corre detrás
      // de un `Payment` real—, o sea que reactivar sería pro gratis. La vuelta es
      // un alta nueva, nunca una resurrección local.
      if (subscription.provider === SubscriptionProvider.CONFIO) {
        throw new RequestException(
          {
            code: 'CONFIO_REACTIVATE_NOT_SUPPORTED',
            message:
              'Una suscripción de ConfioPagos cancelada no se reactiva: hay que darse de alta de nuevo',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      // NO se toca el `status`: acá abajo sólo llegan bajas PENDIENTES —los ciclos
      // cerrados los rechazó el gate de arriba—, y una baja pendiente nunca movió el
      // estado, así que deshacerla tampoco lo mueve. Forzar `active` sobre una fila
      // en prueba le comería los días de trial que le quedan, y sobre una `past_due`
      // borraría la mora sin que nadie haya pagado.
      const fromStatus = subscription.status
      subscription.cancelledAt = null
      subscription.cancelReason = null
      // La fila vuelve a renovarse: ya no hay baja pendiente que datar (invariante de
      // `accessEndsAt`).
      subscription.accessEndsAt = null
      subscription.autoRenew = true
      await this.subscriptionRepository.save(subscription)

      // Registrar evento de reactivación
      await this.subscriptionEventRepository.save(
        this.subscriptionEventRepository.create({
          subscriptionId: subscription.id,
          eventType: SubscriptionEventType.REACTIVATED,
          fromStatus,
          // El estado REAL en el que quedó la fila —igual al de partida, porque
          // deshacer una baja pendiente no lo mueve—, no un `active` de oficio.
          // Mismo criterio que la traza de `cancel`.
          toStatus: subscription.status,
          triggeredBy,
        }),
      )

      this.logger.log(`Suscripción reactivada para marca ${brandId}`)
      return { data: subscription }
    } catch (error) {
      if (error instanceof RequestException) throw error
      // `error?.message` y no `error.message`: un rechazo que no es `Error` haría
      // explotar este catch y subiría un 500 opaco. Mismo criterio que `cancel`.
      this.logger.error(`Error al reactivar suscripción de marca ${brandId}: ${error?.message}`)
      return { error: error.message }
    }
  }

  /**
   * Historial de eventos de suscripción de una marca
   */
  async getHistory(brandId: string) {
    try {
      const subscription = await this.subscriptionReadRepository.findOne({ where: { brandId } })
      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      const events = await this.subscriptionEventReadRepository.find({
        where: { subscriptionId: subscription.id },
        order: { createdAt: 'DESC' },
      })

      return { data: events }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al obtener historial de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }
}
