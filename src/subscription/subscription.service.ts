import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'
import { Subscription, SubscriptionStatus, SubscriptionProvider } from './entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from './entities/subscriptionEvent.entity'
import { ClientRolesService } from '../client/client-roles.service'
import { EventBusService } from '../event-bus/event-bus.service'
import { ConfioTrialService } from './confio-trial.service'
import { RequestException } from '../shared/exception/request.exception'

// Estados en los que la marca tiene servicio vigente; `expired` y `cancelled` son ciclos
// terminados y no deben bloquear un alta nueva.
const LIVE_SUBSCRIPTION_STATUSES = [
  SubscriptionStatus.TRIAL,
  SubscriptionStatus.ACTIVE,
  SubscriptionStatus.PAST_DUE,
]

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
    private readonly clientRoles: ClientRolesService,
    private readonly eventBus: EventBusService,
    private readonly confioTrial: ConfioTrialService,
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
   * ORDEN, que es la invariante de esta tarea: **todo lo falible primero, la
   * escritura después**. Guards de lectura → `POST` a ConfioPagos → plan en roles
   * → transacción corta que escribe la fila y el `TRIAL_STARTED`. Un 5xx de
   * ConfioPagos deja a la marca REINTENTABLE (sin `trialStart`, sin fila nueva) en
   * vez de quemada en `TRIAL_ALREADY_USED`.
   *
   * ⚠️ DESFASE SIN RESOLVER (queda escrito a propósito, no lo arregla esta tarea):
   * nuestro trial arranca en el ALTA y el de ConfioPagos en la ACEPTACIÓN. Si el
   * usuario acepta el día 3, ellos cobran el día 18 y el plan en roles ya expiró el
   * 15; si no acepta nunca, son 15 días de pro regalados que ConfioPagos no cobra
   * jamás. Además su link de aceptación vence a los 7 días por default, contra
   * nuestros 15 de prueba.
   *
   * ⚠️ RESIDUAL ACEPTADO: si la escritura local falla DESPUÉS del `POST`, queda del
   * lado de ConfioPagos una suscripción huérfana en `PENDING_ACCEPTANCE` —que vence
   * sola y no cobra— y un plan en roles que caduca por su `expiresAt`. Se elige eso
   * antes que quemarle la prueba a la marca.
   *
   * ⚠️ CARRERA DEL WEBHOOK, verificada y sin efecto hoy: el `POST` dispara
   * `subscription.subscriptionStatusChanged` con `PENDING_ACCEPTANCE` ANTES de que
   * exista nuestra fila (la escritura llega después de roles, hasta ~10 s más
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

    // `trialStart` es la marca durable de prueba consumida: ningún camino la limpia
    // (el checkout revive la fila sin tocar `trialStart`/`trialEnd` y el cron de
    // expiración solo mueve el estado a EXPIRED).
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
      })

      // Va ANTES de abrir la transacción: es HTTP con timeout de 10 s y adentro
      // retendría el lock del índice único de `brandId` en el camino caliente.
      // Y se ramifica sobre el BOOLEANO, no sobre un throw: `assignPlanToBrand` no
      // lanza nunca —`callRolesApi` (`client-roles.service.ts:323`) atrapa 4xx, 5xx,
      // timeout y `SERVICE_ROLES` ausente y devuelve `false`—, así que un rollback
      // escrito sobre «si rechaza» dejaría pasar de largo una caída de roles y la
      // marca quedaría con la prueba consumida y sin plan.
      const assigned = await this.clientRoles.assignPlanToBrand(brandId, planSlug, trialEnd)
      if (!assigned) {
        throw new RequestException(
          {
            code: 'PLAN_ASSIGNMENT_FAILED',
            message: 'No se pudo activar el plan en el servicio de roles, reintentá en unos minutos',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
      }

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
          status: SubscriptionStatus.TRIAL,
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
          nextBillingDate: trialEnd,
          autoRenew: true,
          cancelledAt: null,
          cancelReason: null,
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
            toStatus: SubscriptionStatus.TRIAL,
            triggeredBy: userId,
            reason: `Trial de ${trialDays} días iniciado`,
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
        `Trial iniciado: ${saved.id} marca ${brandId} plan ${planSlug} hasta ${trialEnd.toISOString()} ` +
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
   * SIN RUTA HTTP a propósito. El `acceptanceUrl` es un link PORTADOR
   * (`confio.types.ts:158`) y este controller es autenticación SOLA, sin ningún
   * `@RequirePermission` (`subscription.controller.ts:29`): un
   * `GET /subscription/acceptance-link?brandId=` le daría a CUALQUIER usuario
   * autenticado el link de CUALQUIER marca. Hoy ese link sólo se obtiene creando el
   * trial, y los guards de una-prueba-por-marca cierran ese camino.
   *
   * La ruta la agrega `front-alta-de-suscripcion`, su único consumidor, y cuando se
   * agregue el `brandId` tiene que salir de `req.user`, no del query. El método se
   * entrega probado para que esa tarea sea sólo cablear.
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
   * Cancelar suscripción
   */
  async cancel(brandId: string, reason: { reason: string; triggeredBy: string }) {
    try {
      const subscription = await this.subscriptionRepository.findOne({ where: { brandId } })
      if (!subscription) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      const fromStatus = subscription.status
      subscription.status = SubscriptionStatus.CANCELLED
      subscription.cancelledAt = new Date()
      subscription.cancelReason = reason.reason
      subscription.autoRenew = false
      await this.subscriptionRepository.save(subscription)

      // Registrar evento de cancelación
      await this.subscriptionEventRepository.save(
        this.subscriptionEventRepository.create({
          subscriptionId: subscription.id,
          eventType: SubscriptionEventType.CANCELLED,
          fromStatus,
          toStatus: SubscriptionStatus.CANCELLED,
          triggeredBy: reason.triggeredBy,
          reason: reason.reason,
        }),
      )

      // Remover plan de la marca en backend-roles
      await this.clientRoles.removePlanFromBrand(brandId, subscription.planSlug)

      this.logger.log(`Suscripción cancelada para marca ${brandId}`)
      return { data: subscription }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al cancelar suscripción de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Reactivar suscripción cancelada
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

      if (subscription.status !== SubscriptionStatus.CANCELLED) {
        throw new RequestException(
          { code: 'SUBSCRIPTION_NOT_CANCELLED', message: 'Solo se pueden reactivar suscripciones canceladas' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      const fromStatus = subscription.status
      subscription.status = SubscriptionStatus.ACTIVE
      subscription.cancelledAt = null
      subscription.cancelReason = null
      subscription.autoRenew = true
      await this.subscriptionRepository.save(subscription)

      // Registrar evento de reactivación
      await this.subscriptionEventRepository.save(
        this.subscriptionEventRepository.create({
          subscriptionId: subscription.id,
          eventType: SubscriptionEventType.REACTIVATED,
          fromStatus,
          toStatus: SubscriptionStatus.ACTIVE,
          triggeredBy,
        }),
      )

      this.logger.log(`Suscripción reactivada para marca ${brandId}`)
      return { data: subscription }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al reactivar suscripción de marca ${brandId}: ${error.message}`)
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
