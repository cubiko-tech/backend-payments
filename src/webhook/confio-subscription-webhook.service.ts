import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, EntityManager, Repository, SelectQueryBuilder } from 'typeorm'

import { Subscription, SubscriptionStatus } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'
import { ConfioProvider } from '../provider/confio/confio.provider'
import {
  ConfioSubscriptionStatus,
  ConfioSubscriptionStatusWire,
  ConfioWebhookPayload,
} from '../provider/confio/confio.types'
import { WebhookEvent } from './entities/webhookEvent.entity'
import { ClientRolesService } from '../client/client-roles.service'
import {
  aFecha,
  estaVencido,
  PeriodoConfio,
  periodoDePrueba,
  periodoLocal,
} from './confio-period.util'
import { armarTrazaDelMovimiento } from './confio-traza.util'
import { downgradeBrandToFree } from '../client/plan-downgrade.util'

/**
 * Mapa `status` de ConfioPagos → estado local, explícito y exportado.
 *
 * `SUSPENDED → past_due` y no un estado terminal: la regla de negocio de la
 * épica 002 dice que el acceso se corta al primer cobro fallido y VUELVE si un
 * cobro posterior tiene éxito, así que suspendido es cortable y recuperable.
 * `CANCELED` y `EXPIRED` sí son terminales del lado de ellos.
 *
 * Los estados que faltan (`PENDING_ACCEPTANCE`, `PROCESSING`) están en
 * `CONFIO_ESTADOS_SIN_EFECTO`: son del ALTA, no del ciclo de cobro. Mientras la
 * suscripción espera que el comprador acepte, el estado local ya lo fijó el alta
 * y pisarlo con un `trial`/`active` prematuro mentiría sobre lo que se pagó.
 *
 * ⚠️ Ahora que existe un `SubscriptionStatus.PENDING` local, la mutación tentadora
 * es completar el mapa con `PENDING_ACCEPTANCE → PENDING`. **NO se hace**, y no por
 * pereza: el alta de PRUEBA también crea su suscripción en ConfioPagos y ellos la
 * dejan en `PENDING_ACCEPTANCE`, disparando el webhook ANTES de que exista nuestra
 * fila (la «CARRERA DEL WEBHOOK» documentada en `SubscriptionService.startTrial`).
 * Con ese mapeo, el re-despacho de ese evento pisaría una fila `trial` YA VIVA —con
 * el plan puesto en roles— devolviéndola a `pending`. `pending` lo escribe NUESTRO
 * endpoint de alta, nunca el wire status.
 * Candado que ya existe y que se pone rojo ante ese mapeo (asserta `manager.save` no
 * llamado): `webhook.service.spec.ts` →
 * `it.each(['PENDING_ACCEPTANCE', 'PROCESSING'])('%s no cambia el estado ni escribe')`.
 */
export const CONFIO_SUBSCRIPTION_STATUS_MAP: { [K in ConfioSubscriptionStatus]?: SubscriptionStatus } = {
  TRIALING: SubscriptionStatus.TRIAL,
  ACTIVE: SubscriptionStatus.ACTIVE,
  PAST_DUE: SubscriptionStatus.PAST_DUE,
  SUSPENDED: SubscriptionStatus.PAST_DUE,
  CANCELED: SubscriptionStatus.CANCELLED,
  EXPIRED: SubscriptionStatus.EXPIRED,
}

/** Estados del alta: se loguean y NO tocan el estado local. */
export const CONFIO_ESTADOS_SIN_EFECTO: ConfioSubscriptionStatusWire[] = ['PENDING_ACCEPTANCE', 'PROCESSING']

/**
 * Los dos estados con los que ConfioPagos reporta una suscripción YA ACEPTADA y
 * corriendo: la prueba que arrancó del lado de ellos y el ciclo pago.
 *
 * Son los que OTORGAN el plan en `backend-roles`, y desde la regla «no se otorga
 * el plan sin suscripción de verdad» son el único momento en que una prueba
 * consigue acceso — el alta no reparte nada.
 *
 * ⚠️ Es DISJUNTO de `CONFIO_ESTADOS_SIN_EFECTO` y tiene que seguir siéndolo:
 * `PENDING_ACCEPTANCE` es el alta esperando que el comprador acepte, o sea
 * exactamente lo contrario de una confirmación. Meterlo acá le daría el plan a
 * quien todavía no registró tarjeta, que es el defecto que esta tarea corrige.
 */
export const CONFIO_ESTADOS_QUE_OTORGAN: ConfioSubscriptionStatus[] = ['TRIALING', 'ACTIVE']

/**
 * `subscription_events.eventType` es un enum de Postgres con exactamente diez
 * valores y NO tiene un `status_changed` genérico; agregarle uno exige una
 * migración, que está fuera del alcance de esta tarea. Se mapea al miembro más
 * cercano y el nombre EXACTO del evento de Confío queda en `metadata.event`,
 * que es lo que `trazabilidad-de-movimientos` va a leer.
 */
const CONFIO_TIPO_DE_EVENTO: { [K in ConfioSubscriptionStatus]?: SubscriptionEventType } = {
  TRIALING: SubscriptionEventType.TRIAL_STARTED,
  ACTIVE: SubscriptionEventType.REACTIVATED,
  PAST_DUE: SubscriptionEventType.PAYMENT_FAILED,
  SUSPENDED: SubscriptionEventType.PAYMENT_FAILED,
  CANCELED: SubscriptionEventType.CANCELLED,
  EXPIRED: SubscriptionEventType.EXPIRED,
}

/** UUID canónico: `subscriptions.id`. Mismo formato que `checkout.service.ts:740`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Estados terminales del lado nuestro: revivirlos merece un aviso. Espejo exacto de
 * `TERMINAL_SUBSCRIPTION_STATUSES` (`subscription.entity.ts`).
 *
 * ⚠️ `pending` NO entra. Este conjunto es el que `planearCobro` usa para decidir si
 * un `SUCCEEDED` es una RESURRECCIÓN; el primer cobro del alta PAGA no lo es: es
 * exactamente el cobro que la fila `pending` estaba esperando. Metiéndolo acá,
 * `revive` daría `true`, el efecto saldría con `roles: undefined` y la fila pasaría a
 * `active` SIN que se le asigne el plan en roles — la marca paga y no habilita nada.
 * Lo fija el caso «el primer cobro exitoso sobre una fila `pending` la activa y le
 * asigna el plan en roles» de `confio-subscription-webhook.service.spec.ts`.
 */
const ESTADOS_TERMINALES = [SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED]

/**
 * ¿La fila tiene una baja NUESTRA todavía en curso?
 *
 * Es la invariante de `accessEndsAt` (`subscription.entity.ts`) leída desde este
 * lado: sello local + acceso ya pagado que aún no venció. Desde
 * `cancelar-marca-baja-al-fin-de-periodo` la baja NO mueve el `status` —la fila se
 * queda en `trial`/`active`/`past_due` mientras le debamos el servicio—, así que
 * `ESTADOS_TERMINALES.includes(sub.status)` dejó de alcanzar para reconocer una
 * suscripción que del lado de ConfioPagos ya está cancelada. Este predicado es la
 * mitad que faltaba, y las dos guardas del archivo lo usan: la que ignora el eco de
 * nuestra propia baja y la que impide resucitarla con un cobro tardío.
 *
 * Discrimina por la FECHA, no sólo por el sello: una vez vencido el acceso la fila
 * vuelve a ser un caso terminal común y el webhook la trata como siempre. La fecha
 * pasa por `aFecha` como todo lo que este archivo lee de la fila: una columna que no
 * vuelva como `Date` (o un `Invalid Date`) tiene que caer del lado de «no hay baja
 * pendiente», que es el comportamiento de siempre, y nunca reventar el handler.
 */
function bajaPendiente(sub: Subscription): boolean {
  const finDeAcceso = aFecha(sub.accessEndsAt)

  return !!sub.cancelledAt && !!finDeAcceso && !estaVencido(finDeAcceso)
}

/**
 * Efecto YA DECIDIDO de un webhook, antes de tocar la base.
 *
 * Se calcula fuera de la transacción (incluida la consulta al proveedor, que es
 * red) y se aplica adentro sobre la fila BLOQUEADA: nunca se sostiene una
 * transacción abierta a través de la red.
 */
interface EfectoConfio {
  eventType: SubscriptionEventType
  toStatus: SubscriptionStatus
  /** Sólo el cobro exitoso avanza el período. */
  avanzaPeriodo?: boolean
  /** Período del cobro: el del proveedor, o el avance local. */
  periodo?: PeriodoConfio
  reiniciaReintentos?: boolean
  /** `CANCELED` sella `cancelledAt`, pero sólo si venía nulo. */
  sellaCancelacion?: boolean
  /** Movimiento de acceso en `backend-roles`; ausente = no se toca roles. */
  roles?: EfectoRoles
  /**
   * Motivo para la COLUMNA `reason` cuando el payload no trae uno propio: el
   * hecho que degradó tiene que ser identificable desde la fila sola.
   */
  reason?: string
}

/**
 * Movimiento de acceso en `backend-roles`, decidido ANTES de tocar la base.
 *
 * Lleva `brandId` y `planSlug` PROPIOS en vez de releerlos de la fila bloqueada:
 * así lo que se empujó a roles y lo que queda escrito en `metadata` son el MISMO
 * dato, incluso si otra escritura le cambiara el plan a la fila en el medio.
 */
interface EfectoRoles {
  /**
   * `retirar` es la mora (saca el plan pago y nada más), `degradar` es la baja
   * definitiva (saca el pago y deja `free`) y `reponer` es el cobro exitoso.
   */
  accion: 'retirar' | 'reponer' | 'degradar'
  brandId: string
  planSlug: string
  /** Sólo la reposición: fin del período que se acaba de cobrar. */
  expiresAt?: Date
}

/**
 * Handler del ramo FIRMADO del webhook de ConfioPagos: los dos eventos
 * `subscription.*` (`webhook.service.ts` → `dispatchEvent`, rama `confio`).
 *
 * Vive en su propio archivo porque `webhook.service.ts` ya está en el límite de
 * tamaño del repo (400 líneas); el ruteo se queda allá y sólo la lógica de
 * suscripción está acá.
 *
 * Ningún camino de acá lanza por un hecho de negocio (suscripción no resuelta,
 * estado no mapeado, efecto ya aplicado): se loguea y se vuelve, para que
 * `processEvent` marque el evento `processed` y el endpoint responda 200 —un
 * fallo del canal no puede convertirse en un hecho sobre el objeto—. Los
 * errores REALES de base sí se dejan propagar, así la cola reintenta.
 *
 * Sí lanza, y sólo, cuando `backend-roles` rechaza el movimiento de acceso: eso
 * es un fallo de CANAL, no un hecho del objeto, y lanzar antes de abrir la
 * transacción deja cero escrituras locales —ni `past_due`, ni marcador, ni
 * historial— para que el reintento del webhook vuelva a intentarlo entero. Lo
 * recíproco también vale: no recibir el webhook no retira nada.
 *
 * ⚠️ Residual aceptado: dos eventos DISTINTOS de la misma suscripción son
 * last-write-wins, así que una entrega fuera de orden puede aplicar un estado
 * viejo. Resolverlo pide una marca de agua por tiempo de evento, o sea una
 * migración: fuera de alcance. La concurrencia del MISMO evento sí está resuelta
 * (marcador releído bajo `pessimistic_write`).
 */
@Injectable()
export class ConfioSubscriptionWebhookService {
  private readonly logger = new Logger(ConfioSubscriptionWebhookService.name)

  constructor(
    @InjectRepository(Subscription, 'DBWrite')
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(SubscriptionEvent, 'DBWrite')
    private readonly subscriptionEventRepository: Repository<SubscriptionEvent>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
    private readonly confio: ConfioProvider,
    private readonly clientRoles: ClientRolesService,
  ) {}

  async handle(event: WebhookEvent): Promise<void> {
    const payload: ConfioWebhookPayload = event?.payload || {}
    const data = payload.data || {}

    const sub = await this.resolverSuscripcion(data)
    if (!sub) {
      this.logger.warn(
        `Confio suscripción no resuelta: name=${data.name} correlationId=${data.correlationId}`,
      )
      return
    }

    // Atajo de re-despacho: evita volver a consultar al proveedor. NO es la
    // garantía —esa es la relectura bajo el lock, más abajo—, es sólo el ahorro.
    const yaAplicado = await ConfioSubscriptionWebhookService.buscarMarcador(
      this.subscriptionEventRepository.createQueryBuilder('e'),
      sub.id,
      event.providerEventId,
    )
    if (yaAplicado) {
      this.logger.log(`Confio efecto ya aplicado para ${event.providerEventId}, no se repite`)
      return
    }

    const efecto = payload.event === 'subscription.billingStatusChanged'
      ? await this.planearCobro(data, sub)
      : await this.planearCambioDeEstado(data, sub)
    if (!efecto) return

    if (efecto.roles) {
      await this.sincronizarAccesoEnRoles(efecto.roles, sub.id, event.providerEventId)
    }

    await this.aplicar(sub.id, efecto, payload, event.providerEventId)
  }

  /**
   * Resolución por resource name y, si eso no da, por `correlationId` cuando es
   * un UUID (nuestro `subscriptions.id`).
   *
   * Los dos `findOne` van guardados contra `undefined` A PROPÓSITO: TypeORM
   * DESCARTA una condición con valor `undefined` y devolvería una suscripción
   * CUALQUIERA — una escritura cruzada entre marcas, en silencio.
   *
   * Se lee contra la escritura y no contra la réplica por el mismo argumento ya
   * escrito en `webhook.service.ts:55`: el lag de la réplica no entra acá.
   */
  private async resolverSuscripcion(data: ConfioWebhookPayload['data']): Promise<Subscription | null> {
    if (data?.name) {
      const porNombre = await this.subscriptionRepository.findOne({
        where: { providerSubscriptionId: data.name },
      })
      if (porNombre) return porNombre
    }

    const correlationId = data?.correlationId
    if (typeof correlationId === 'string' && UUID_RE.test(correlationId)) {
      return await this.subscriptionRepository.findOne({ where: { id: correlationId } })
    }

    return null
  }

  /** Cobro del ciclo: `SUCCEEDED` renueva; cualquier otro estado deja mora. */
  private async planearCobro(
    data: ConfioWebhookPayload['data'],
    sub: Subscription,
  ): Promise<EfectoConfio> {
    if (data?.status !== 'SUCCEEDED') {
      // El acceso pro se corta al PRIMER cobro fallido que reporte el webhook,
      // sin período de gracia (regla de negocio de la épica 002). Se retira el
      // plan de la suscripción y NO se asigna `free`: un plan free no se cobra y
      // la degradación es de `degradacion-a-free-y-baja-en-roles`.
      //
      // Corta cualquier estado que no sea `SUCCEEDED` y no una lista de fallos
      // porque `billingStatusChanged` sólo reporta cobros YA procesados
      // («exitoso o fallido», tabla de eventos del contrato): hoy no hay estado
      // intermedio. Si Confío agrega uno, este predicado lo leería como impago.
      //
      // ⚠️ DINERO: escribir `past_due` arma un cron VIEJO. `retryFailedPayments`
      // (`tasks.service.ts:216-250`, cada 6h) toma `PAST_DUE + autoRenew` y para
      // `provider === 'confio'` emite un link de pago REAL con aviso al usuario;
      // `expireSubscriptions` después la vence por `retryCount`. Con la recurrencia
      // delegada eso cobraría por un segundo riel. Hoy es LATENTE (ninguna
      // suscripción confío tiene resource name) y retirarlo es de
      // `alta-crea-suscripcion-en-confiopagos`: no se toca un camino que gasta plata.
      this.logger.warn(`Confio cobro no exitoso para ${sub.id}: status=${data?.status}`)
      return {
        eventType: SubscriptionEventType.PAYMENT_FAILED,
        toStatus: SubscriptionStatus.PAST_DUE,
        roles: this.efectoRoles('retirar', sub),
      }
    }

    // El período se resuelve ACÁ, en la fase de decisión, y no al aplicar: el
    // `expiresAt` que se le promete a roles tiene que ser EXACTAMENTE el
    // `currentPeriodEnd` que después se persiste. Resolverlo dos veces (una para
    // roles, otra para la fila) permitiría que difieran.
    const periodo = (await this.leerPeriodoDelProveedor(data, sub)) || periodoLocal(sub)

    // Resurrección: un `SUCCEEDED` tardío sobre una suscripción que del lado
    // NUESTRO ya está cancelada o vencida no repone el acceso. El mapeo de estado
    // lo dicta la aceptación y se aplica (con el aviso de `aplicar`, medido sobre
    // la fila bloqueada), pero conceder pro por el cobro de una suscripción que
    // consideramos muerta es la mitad IRREVERSIBLE: se decide ACÁ, no después de
    // haber empujado el movimiento a roles.
    //
    // Una baja PENDIENTE cuenta como muerta a estos efectos, y por eso el predicado
    // no es sólo el `status`: la fila sigue en `trial`/`active` porque le debemos el
    // acceso ya pagado, pero del lado de ConfioPagos ya está `CANCELED` y no vuelve
    // a cobrar. Un `SUCCEEDED` que llegue después —un link one-shot emitido ANTES de
    // la baja y pagado a destiempo, o un cobro en vuelo— no puede volver a comprar
    // el plan: la vuelta es un alta nueva por checkout, con pago propio.
    //
    // Una fila `pending` (alta PAGA que todavía no pagó su primer ciclo) NO cae acá,
    // y tiene que seguir sin caer: ese `SUCCEEDED` es su PRIMER cobro, no un cobro
    // tardío sobre algo que dimos por muerto, así que baja por el camino normal y
    // repone el plan en roles con `efectoRoles('reponer', …)`. La guarda muerde sólo
    // sobre `cancelled`/`expired` y sobre la baja pendiente.
    const revive = ESTADOS_TERMINALES.includes(sub.status) || bajaPendiente(sub)
    if (revive) {
      const porQue = ESTADOS_TERMINALES.includes(sub.status) ? sub.status : 'dada de baja'
      this.logger.warn(
        `Confio cobro exitoso sobre una suscripción ${porQue} (${sub.id}): no se repone el plan en roles`,
      )
    }

    return {
      eventType: SubscriptionEventType.PAYMENT_SUCCEEDED,
      toStatus: SubscriptionStatus.ACTIVE,
      avanzaPeriodo: true,
      reiniciaReintentos: true,
      periodo,
      roles: revive ? undefined : this.efectoRoles('reponer', sub, periodo.end),
    }
  }

  /**
   * Descriptor de roles, o `undefined` cuando la fila no alcanza para armarlo.
   *
   * La guarda es barata y necesaria: `brandId`/`planSlug` van al path de roles
   * (`/v1/brand/{id}/plan/slug/{slug}`), y uno vacío devolvería 404 → `false` →
   * un fallo de canal que reintentaría en bucle sin poder resolverse nunca.
   */
  private efectoRoles(
    accion: EfectoRoles['accion'],
    sub: Subscription,
    expiresAt?: Date,
  ): EfectoRoles | undefined {
    if (!sub.brandId || !sub.planSlug) {
      this.logger.warn(
        `Confio ${sub.id} sin brandId/planSlug: no se ${accion} el plan en roles (brand=${
          sub.brandId
        } plan=${sub.planSlug})`,
      )
      return undefined
    }

    return { accion, brandId: sub.brandId, planSlug: sub.planSlug, expiresAt }
  }

  /**
   * Empuje del movimiento de acceso a `backend-roles`.
   *
   * (1) Se ramifica sobre el BOOLEANO y no sobre un throw: `callRolesApi`
   *     (`client-roles.service.ts:323-357`) atrapa 4xx, 5xx, timeout y
   *     `SERVICE_ROLES` ausente y devuelve `false`, así que un rollback escrito
   *     sobre «si rechaza» dejaría pasar de largo una caída de roles. Mismo
   *     precedente que el alta (`subscription.service.ts:179-190`).
   * (2) Se llama ANTES de la transacción: es HTTP con timeout de 10 s y adentro
   *     retendría el lock de la fila todo ese tiempo.
   * (3) Lanzar deja CERO escrituras locales, o sea que un canal caído no puede
   *     quedar registrado como impago ni degradar por sí solo; el mensaje queda
   *     en `webhook_events.error` y el evento se marca para reintento. Ese
   *     reintento HOY no reprocesa solo (`webhook.processor.ts` incrementa el
   *     contador y relanza): la reparación entra por `POST /webhook/:id/retry`.
   *     Deuda preexistente de todos los proveedores, no de este camino.
   * (4) La degradación (`degradar`) delega en `plan-downgrade.util.ts`, que es el
   *     único dueño del movimiento y lo comparte con los dos crons de
   *     `tasks.service.ts`: retira el plan pago y deja `free` SIN `expiresAt`.
   * (5) La reposición usa `assignPlanToBrand` y NUNCA `renewPlanForBrand`:
   *     `assignPlanToBrandBySlug` es un upsert (actualiza `expiresAt` si el
   *     vínculo existe, lo crea si no), mientras que el `renew` tira 404 cuando
   *     la marca no tiene el plan — que es justo el estado que dejó el retiro.
   *
   * ⚠️ `callRolesApi` colapsa 404 y 503 en el mismo `false`, así que un plan que
   * NO esté sembrado en el catálogo de roles se lee acá como canal caído y el
   * evento termina en dead letter tras 3 intentos. Falla ruidosa —lo correcto
   * para un error de configuración—, pero mientras `plan-dropi-roax-en-catalogo`
   * siga abierto es el resultado esperado de todo cobro de `dropi-roax`.
   */
  private async sincronizarAccesoEnRoles(
    roles: EfectoRoles,
    subscriptionId: string,
    providerEventId: string,
  ): Promise<void> {
    const traza = `brand=${roles.brandId} plan=${roles.planSlug} sub=${subscriptionId} event=${providerEventId}`

    const ok = roles.accion === 'degradar'
      ? await downgradeBrandToFree(this.clientRoles, roles.brandId, roles.planSlug)
      : roles.accion === 'retirar'
        ? await this.clientRoles.removePlanFromBrand(roles.brandId, roles.planSlug)
        : await this.clientRoles.assignPlanToBrand(roles.brandId, roles.planSlug, roles.expiresAt)

    if (!ok) {
      throw new Error(`No se pudo ${roles.accion} el plan en backend-roles: ${traza}`)
    }

    const hasta = roles.expiresAt ? ` expiresAt=${roles.expiresAt.toISOString()}` : ''
    this.logger.log(`Confio acceso en roles: ${roles.accion} aplicado ${traza}${hasta}`)
  }

  /**
   * Período según ConfioPagos, o `undefined` para avanzar localmente.
   *
   * El resource name sale de `data.name` y, si no vino, de la fila: sin ese
   * segundo intento el camino del `correlationId` degradaría SIEMPRE, porque
   * `ConfioProvider.toSubscriptionPath` rechaza un name vacío
   * (`invalid_subscription_name`) y el fallo se leería como «se cayó Confío».
   *
   * Las tres fechas se validan una por una: `ConfioSubscriptionResult` las
   * declara obligatorias pero llegan `undefined` en runtime mientras la
   * suscripción no abrió período, y con `strictNullChecks: false`
   * (`tsconfig.json`) el compilador no lo ve.
   */
  private async leerPeriodoDelProveedor(
    data: ConfioWebhookPayload['data'],
    sub: Subscription,
  ): Promise<PeriodoConfio | undefined> {
    const resourceName = data?.name || sub.providerSubscriptionId
    if (!resourceName) {
      this.logger.warn(
        `Confio sin resource name para ${sub.id}: se avanza un ciclo local (no es un fallo del proveedor)`,
      )
      return undefined
    }

    try {
      const remota = await this.confio.getSubscription(resourceName)
      const start = aFecha(remota?.currentPeriodStart)
      const end = aFecha(remota?.currentPeriodEnd)
      const nextBilling = aFecha(remota?.nextBillingTime)

      if (start && end && nextBilling) {
        // Un período YA VENCIDO no sirve ni como `expiresAt` (roles lo barre)
        // ni como `nextBillingDate` (⚠️ DINERO): se degrada al avance local, que
        // tiene piso en el ahora. Razones completas en `confio-period.util.ts`.
        if (!estaVencido(end)) return { start, end, nextBilling }

        this.logger.warn(
          `Confio devolvió un período ya vencido para ${sub.id} (fin=${end.toISOString()}): ` +
            'se avanza un ciclo local',
        )
        return undefined
      }

      this.logger.warn(
        `Confio devolvió un período incompleto para ${sub.id} (fuente=${
          data?.name ? 'data.name' : 'providerSubscriptionId'
        }): se avanza un ciclo local`,
      )
      return undefined
    } catch (error) {
      this.logger.warn(
        `Confio no respondió el período de ${sub.id} (${error?.message}): se avanza un ciclo local`,
      )
      return undefined
    }
  }

  /**
   * Cambio de estado de la suscripción. `null` = no hay nada que aplicar.
   *
   * Es `async` desde que la CONFIRMACIÓN otorga acceso: `TRIALING`/`ACTIVE`
   * necesitan el período del proveedor, y eso es red. Sigue calculándose fuera
   * de la transacción, como el cobro.
   */
  private async planearCambioDeEstado(
    data: ConfioWebhookPayload['data'],
    sub: Subscription,
  ): Promise<EfectoConfio | null> {
    const wire: ConfioSubscriptionStatusWire = data?.status || ''

    if (CONFIO_ESTADOS_SIN_EFECTO.includes(wire)) {
      this.logger.log(`Confio estado del alta ignorado: ${wire} (${data?.name})`)
      return null
    }

    // Se indexa con un cast porque la clave viene de la red y el tipo `Wire`
    // admite un estado que Confío agregue mañana: ese cae acá como no mapeado.
    //
    // El `hasOwnProperty` NO es ceremonia: `wire` es texto de la red y el mapa es
    // un object literal, así que `"constructor"` o `"valueOf"` devuelven una
    // FUNCIÓN heredada del prototipo —truthy, o sea que pasa el guard de abajo— y
    // terminaría asignada a `sub.status`, que es un enum de Postgres.
    const mapeado = Object.prototype.hasOwnProperty.call(CONFIO_SUBSCRIPTION_STATUS_MAP, wire)
    const toStatus = mapeado ? CONFIO_SUBSCRIPTION_STATUS_MAP[wire as ConfioSubscriptionStatus] : undefined
    if (!toStatus) {
      this.logger.warn(`Confio estado no mapeado: ${wire} (${data?.name})`)
      return null
    }

    // Idempotencia por ESTADO TERMINAL, no sólo por `providerEventId`: ese id se
    // acuña con `resource:event:status:updateTime` (`confio-webhook.ts`), así que
    // la secuencia normal CANCELED→EXPIRED son DOS eventos distintos y los dos
    // terminales. Sin esta guarda el segundo volvería a llamar a roles y
    // escribiría un segundo `subscription_event` sobre una suscripción ya muerta,
    // que es justo lo que prohíbe la aceptación 4. Peor todavía con el
    // last-write-wins que documenta el header: un terminal fuera de orden que
    // llegue DESPUÉS de un `SUCCEEDED` que repuso el plan le sacaría el plan pago
    // a una marca que acaba de pagar y la dejaría en `free`. Es la guarda
    // recíproca de la resurrección de `planearCobro`.
    if (ESTADOS_TERMINALES.includes(toStatus) && ESTADOS_TERMINALES.includes(sub.status)) {
      this.logger.log(
        `Confio ${wire} sobre una suscripción ya ${sub.status} (${sub.id}): sin efecto, ya está de baja`,
      )
      return null
    }

    const esTerminal = ESTADOS_TERMINALES.includes(toStatus)

    // EL ECO DE NUESTRA PROPIA BAJA. `SubscriptionService.cancel` cancela PRIMERO en
    // ConfioPagos y ellos devuelven el hecho por webhook: ese `CANCELED` describe la
    // MISMA baja que nosotros ya sellamos, no una decisión del proveedor. La guarda
    // de arriba no lo agarra porque desde el corte diferido la fila NO queda
    // terminal, y sin ésta el camino principal de la baja quedaba anulado:
    //   (a) `efectoRoles('degradar')` le sacaba el plan a la marca segundos después
    //       de que la baja se lo conservó — la aceptación entera de
    //       `cancelar-marca-baja-al-fin-de-periodo` sólo era cierta en los tests;
    //   (b) `aplicar` escribía un SEGUNDO `SubscriptionEvent` CANCELLED del mismo
    //       hecho, que es lo que la idempotencia de `cancel` existe para evitar;
    //   (c) quedaba `status = cancelled` con `accessEndsAt` NO nula, rompiendo la
    //       invariante de la columna y dejando a la fila lista para una SEGUNDA
    //       degradación cuando aterrice el cron de retiro.
    // Mientras le debamos el acceso ya pagado esto es SIN EFECTO —ni roles, ni
    // estado, ni traza—: la degradación tiene un solo dueño, el cron que barre
    // `autoRenew = false` + `accessEndsAt` vencida. Una vez pasada esa fecha
    // `bajaPendiente` deja de valer y el terminal se aplica como siempre.
    if (esTerminal && bajaPendiente(sub)) {
      this.logger.log(
        `Confio ${wire} sobre la baja que ya registramos (${sub.id}): sin efecto, ` +
          `el acceso pagado corre hasta ${aFecha(sub.accessEndsAt).toISOString()}`,
      )
      return null
    }

    // LA CONFIRMACIÓN ES LA QUE OTORGA. `TRIALING`/`ACTIVE` son los dos estados
    // con los que ConfioPagos reporta una suscripción ya aceptada y corriendo, y
    // desde la regla «no se otorga el plan sin suscripción de verdad» (Manuel,
    // 2026-09-02) son el ÚNICO momento en el que la prueba consigue acceso: el
    // alta ya no reparte nada. Antes acá había un hueco deliberado —`ACTIVE` no
    // reponía «porque ese efecto no trae período»—, y lo que lo cierra es pedirle
    // el período al proveedor, igual que hace el cobro.
    if (CONFIO_ESTADOS_QUE_OTORGAN.includes(wire as ConfioSubscriptionStatus)) {
      return await this.planearOtorgamiento(data, sub, wire as ConfioSubscriptionStatus, toStatus)
    }

    // Dos escalones distintos y un solo predicado para cada uno:
    // - `PAST_DUE`/`SUSPENDED` (los dos wire states que el mapa manda a
    //   `past_due`) son MORA: se retira el plan pago y NADA más. Un primer cobro
    //   fallido es recuperable por definición y poner `free` ahí lo convertiría
    //   en una baja de plan (`corte-de-acceso-al-primer-fallo`).
    // - `CANCELED`/`EXPIRED` son terminales: ya no hay cobro posible, así que la
    //   marca pierde el plan pago y baja a `free`.
    const roles = esTerminal
      ? this.efectoRoles('degradar', sub)
      : toStatus === SubscriptionStatus.PAST_DUE
        ? this.efectoRoles('retirar', sub)
        : undefined

    return {
      eventType: CONFIO_TIPO_DE_EVENTO[wire as ConfioSubscriptionStatus],
      toStatus,
      sellaCancelacion: toStatus === SubscriptionStatus.CANCELLED,
      // El hecho que degradó, legible desde la fila de historial sin el payload.
      ...(esTerminal ? { reason: `ConfioPagos reportó la suscripción ${wire}` } : {}),
      ...(roles ? { roles } : {}),
    }
  }

  /**
   * La suscripción quedó aceptada del lado de ConfioPagos: acá es donde la marca
   * consigue el acceso.
   *
   * El `expiresAt` que se le promete a roles y el `currentPeriodEnd` que después
   * se persiste son EL MISMO objeto: el período se resuelve una sola vez, en la
   * fase de decisión. Resolverlo dos veces —una para roles, otra para la fila—
   * permitiría que difieran, que es el defecto que `planearCobro` ya evita.
   *
   * El respaldo depende de QUÉ se confirmó, y por eso no es uno solo:
   * - `ACTIVE` es un ciclo pago: `periodoLocal`, el mismo del cobro.
   * - `TRIALING` es la prueba: `periodoDePrueba`, que respeta el `trialEnd` ya
   *   sellado. Caer al mensual acá regalaría 30 días de acceso sobre una prueba
   *   de 15.
   * Sin ningún período utilizable NO se otorga: el estado se aplica igual —lo
   * dicta el proveedor— pero el acceso no se inventa. Queda el warn para
   * re-despachar el evento (`POST /webhook/:id/retry`) cuando Confío conteste.
   */
  private async planearOtorgamiento(
    data: ConfioWebhookPayload['data'],
    sub: Subscription,
    wire: ConfioSubscriptionStatus,
    toStatus: SubscriptionStatus,
  ): Promise<EfectoConfio> {
    const efecto: EfectoConfio = { eventType: CONFIO_TIPO_DE_EVENTO[wire], toStatus }

    // Misma guarda de resurrección que `planearCobro`, y por el mismo motivo: una
    // confirmación tardía sobre algo que del lado NUESTRO ya está muerto —o con
    // una baja pendiente, que del lado de ellos ya está `CANCELED`— no vuelve a
    // comprar el plan. La vuelta es un alta nueva, con su propio pago.
    if (ESTADOS_TERMINALES.includes(sub.status) || bajaPendiente(sub)) {
      this.logger.warn(
        `Confio ${wire} sobre una suscripción que dimos por muerta (${sub.id}, ${sub.status}): ` +
          'se aplica el estado pero NO se otorga el plan en roles',
      )
      return efecto
    }

    const periodo =
      (await this.leerPeriodoDelProveedor(data, sub)) ||
      (toStatus === SubscriptionStatus.TRIAL ? periodoDePrueba(sub) : periodoLocal(sub))
    if (!periodo) {
      this.logger.warn(
        `Confio ${wire} para ${sub.id} sin período utilizable (trialEnd=${sub.trialEnd}): ` +
          'se aplica el estado pero NO se otorga el plan en roles',
      )
      return efecto
    }

    const roles = this.efectoRoles('reponer', sub, periodo.end)

    return { ...efecto, avanzaPeriodo: true, periodo, ...(roles ? { roles } : {}) }
  }

  /**
   * Escritura atómica: fila bloqueada, marcador releído bajo ese lock, estado y
   * fila de historial.
   *
   * La relectura del marcador ACÁ ADENTRO es la garantía de idempotencia real:
   * `retryWebhook` (admin) y la cola de reintentos pueden despachar el MISMO
   * `WebhookEvent` a la vez, y el chequeo previo por sí solo dejaría escribir a
   * los dos. El parche se recalcula sobre la fila BLOQUEADA, no sobre la copia
   * que se leyó antes.
   */
  private async aplicar(
    subscriptionId: string,
    efecto: EfectoConfio,
    payload: ConfioWebhookPayload,
    providerEventId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager: EntityManager) => {
      const sub = await manager.findOne(Subscription, {
        where: { id: subscriptionId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!sub) return

      const marcador = await ConfioSubscriptionWebhookService.buscarMarcador(
        manager.createQueryBuilder(SubscriptionEvent, 'e'),
        subscriptionId,
        providerEventId,
      )
      if (marcador) {
        this.logger.log(`Confio efecto ya aplicado (bajo lock) para ${providerEventId}, no se repite`)
        return
      }

      const fromStatus = sub.status
      // Resurrección: la aceptación DICTA el mapeo, así que se aplica, pero una
      // entrega tardía puede devolver a `active` algo cancelado. Aviso + INBOX.
      if (ESTADOS_TERMINALES.includes(fromStatus) && efecto.toStatus !== fromStatus) {
        this.logger.warn(
          `Confio reactiva una suscripción en estado terminal: ${subscriptionId} ${fromStatus} → ${efecto.toStatus}`,
        )
      }

      sub.status = efecto.toStatus
      if (efecto.reiniciaReintentos) sub.retryCount = 0
      if (efecto.sellaCancelacion && !sub.cancelledAt) sub.cancelledAt = new Date()
      // ⚠️ DINERO: una fila terminal con `autoRenew` encendido sigue siendo
      // elegible para `processSubscriptionRenewals` y `retryFailedPayments`, que
      // emiten cobro. Se deriva del MISMO predicado con el que se decidió
      // `degradar`, así que los dos no pueden divergir.
      if (ESTADOS_TERMINALES.includes(efecto.toStatus)) sub.autoRenew = false
      // ⚠️ DINERO: `nextBillingDate` alimenta a `processSubscriptionRenewals`
      // (`tasks.service.ts:176-200`), que renueva lo que ya cobra ConfioPagos.
      if (efecto.avanzaPeriodo) ConfioSubscriptionWebhookService.avanzarPeriodo(sub, efecto.periodo)

      await manager.save(sub)

      // La traza se arma con el `sub` que se acaba de leer BAJO EL LOCK: marca,
      // usuario y plan salen de esa fila y no de una relectura posterior.
      await manager.save(
        SubscriptionEvent,
        armarTrazaDelMovimiento({
          sub,
          fromStatus,
          eventType: efecto.eventType,
          toStatus: efecto.toStatus,
          payload,
          providerEventId,
          roles: efecto.roles,
          reason: efecto.reason,
        }),
      )
    })
  }

  /**
   * Asigna el trío de fechas ya resuelto en la fase de decisión.
   *
   * El respaldo local subió a `planearCobro` (que necesita el `end` para
   * prometerlo a roles), así que ahora se calcula sobre la lectura SIN lock:
   * aceptable porque el MISMO evento sigue deduplicado y dos eventos DISTINTOS
   * ya eran last-write-wins. La alternativa era prometer un `expiresAt` distinto
   * del que se persiste, o sostener HTTP dentro de la transacción.
   */
  private static avanzarPeriodo(sub: Subscription, periodo: PeriodoConfio): void {
    sub.currentPeriodStart = periodo.start
    sub.currentPeriodEnd = periodo.end
    sub.nextBillingDate = periodo.nextBilling
  }

  /**
   * Marcador de efecto aplicado: la fila de historial que lleva este
   * `providerEventId` en su `metadata`.
   *
   * Predicado jsonb LITERAL a propósito, sondeado contra la BD de dev antes de
   * escribirlo (`metadata ->> 'providerEventId'`, `metadata` es `jsonb`). Se
   * acota por `subscriptionId` —que tiene índice— y NUNCA por una ventana de
   * filas: `retryWebhook` puede re-despachar un evento arbitrariamente viejo y
   * el marcador quedaría fuera de cualquier ventana fija, regalando un período.
   */
  private static buscarMarcador(
    qb: SelectQueryBuilder<SubscriptionEvent>,
    subscriptionId: string,
    providerEventId: string,
  ): Promise<SubscriptionEvent | null> {
    return qb
      .where('e."subscriptionId" = :sid', { sid: subscriptionId })
      .andWhere("e.metadata ->> 'providerEventId' = :pid", { pid: providerEventId })
      .getOne()
  }
}
