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

/** Estados terminales del lado nuestro: revivirlos merece un aviso. */
const ESTADOS_TERMINALES = [SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED]

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
  /** Período resuelto en ConfioPagos; sin él se avanza un ciclo local. */
  periodo?: { start: Date; end: Date; nextBilling: Date }
  reiniciaReintentos?: boolean
  /** `CANCELED` sella `cancelledAt`, pero sólo si venía nulo. */
  sellaCancelacion?: boolean
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
      : this.planearCambioDeEstado(data)
    if (!efecto) return

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
      // El corte de acceso en `backend-roles` NO es de esta tarea: lo hace
      // `corte-de-acceso-al-primer-fallo`. Acá sólo queda el estado local.
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
      }
    }

    return {
      eventType: SubscriptionEventType.PAYMENT_SUCCEEDED,
      toStatus: SubscriptionStatus.ACTIVE,
      avanzaPeriodo: true,
      reiniciaReintentos: true,
      periodo: await this.leerPeriodoDelProveedor(data, sub),
    }
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
  ): Promise<EfectoConfio['periodo']> {
    const resourceName = data?.name || sub.providerSubscriptionId
    if (!resourceName) {
      this.logger.warn(
        `Confio sin resource name para ${sub.id}: se avanza un ciclo local (no es un fallo del proveedor)`,
      )
      return undefined
    }

    try {
      const remota = await this.confio.getSubscription(resourceName)
      const start = ConfioSubscriptionWebhookService.aFecha(remota?.currentPeriodStart)
      const end = ConfioSubscriptionWebhookService.aFecha(remota?.currentPeriodEnd)
      const nextBilling = ConfioSubscriptionWebhookService.aFecha(remota?.nextBillingTime)

      if (start && end && nextBilling) return { start, end, nextBilling }

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

  /** Cambio de estado de la suscripción. `null` = no hay nada que aplicar. */
  private planearCambioDeEstado(data: ConfioWebhookPayload['data']): EfectoConfio | null {
    const wire: ConfioSubscriptionStatusWire = data?.status || ''

    if (CONFIO_ESTADOS_SIN_EFECTO.includes(wire)) {
      this.logger.log(`Confio estado del alta ignorado: ${wire} (${data?.name})`)
      return null
    }

    // Se indexa con un cast porque la clave viene de la red y el tipo `Wire`
    // admite un estado que Confío agregue mañana: ese cae acá como no mapeado.
    const toStatus = CONFIO_SUBSCRIPTION_STATUS_MAP[wire as ConfioSubscriptionStatus]
    if (!toStatus) {
      this.logger.warn(`Confio estado no mapeado: ${wire} (${data?.name})`)
      return null
    }

    return {
      eventType: CONFIO_TIPO_DE_EVENTO[wire as ConfioSubscriptionStatus],
      toStatus,
      sellaCancelacion: toStatus === SubscriptionStatus.CANCELLED,
    }
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
      // ⚠️ DINERO: `nextBillingDate` alimenta a `processSubscriptionRenewals`
      // (`tasks.service.ts:176-200`), que renueva lo que ya cobra ConfioPagos.
      if (efecto.avanzaPeriodo) ConfioSubscriptionWebhookService.avanzarPeriodo(sub, efecto.periodo)

      await manager.save(sub)

      const data = payload.data || {}
      await manager.save(SubscriptionEvent, {
        subscriptionId,
        eventType: efecto.eventType,
        fromStatus,
        toStatus: efecto.toStatus,
        triggeredBy: 'confio-webhook',
        metadata: {
          event: payload.event,
          cycleNumber: data.cycleNumber,
          amountCents: data.amountCents,
          currencyCode: data.currencyCode,
          providerEventId,
        },
      })
    })
  }

  /** Período del proveedor, o un ciclo mensual desde el fin del anterior. */
  private static avanzarPeriodo(sub: Subscription, periodo: EfectoConfio['periodo']): void {
    if (periodo) {
      sub.currentPeriodStart = periodo.start
      sub.currentPeriodEnd = periodo.end
      sub.nextBillingDate = periodo.nextBilling
      return
    }

    const inicio = ConfioSubscriptionWebhookService.aFecha(sub.currentPeriodEnd) || new Date()
    const fin = ConfioSubscriptionWebhookService.sumarUnCicloMensual(inicio)
    sub.currentPeriodStart = inicio
    sub.currentPeriodEnd = fin
    sub.nextBillingDate = fin
  }

  /** Un mes calendario, recortado al último día cuando el destino es más corto. */
  private static sumarUnCicloMensual(desde: Date): Date {
    const fin = new Date(desde.getTime())
    const dia = fin.getUTCDate()
    fin.setUTCMonth(fin.getUTCMonth() + 1)
    if (fin.getUTCDate() < dia) fin.setUTCDate(0)

    return fin
  }

  /** `Date` utilizable, o `undefined`. Un `Invalid Date` NO es utilizable. */
  private static aFecha(valor: Date | string | undefined): Date | undefined {
    if (!valor) return undefined
    const fecha = valor instanceof Date ? valor : new Date(valor)

    return isNaN(fecha.getTime()) ? undefined : fecha
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
