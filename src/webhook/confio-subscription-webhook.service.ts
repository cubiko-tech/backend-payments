// R6: Keeps the Confio subscription webhook state machine, period resolution, and role sync together.
import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, EntityManager, Repository, SelectQueryBuilder } from 'typeorm'

import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
  SubscriptionTraceStatus,
} from '../subscription/entities/subscriptionEvent.entity'
import { ConfioProvider } from '../provider/confio/confio.provider'
import {
  ConfioSubscriptionResult,
  ConfioSubscriptionStatus,
  ConfioSubscriptionStatusWire,
  ConfioWebhookPayload,
} from '../provider/confio/confio.types'
import { MAX_CONFIO_STRING_LENGTH } from '../provider/confio/confio-webhook-signature'
import { buildLegacyConfioStatusChangedEventId } from '../provider/confio/confio-webhook'
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
import { advanceMark, isOutOfOrder, NoticeOrder, readNoticeOrder } from './confio-watermark.util'
import { downgradeBrandToFree } from '../client/plan-downgrade.util'
import { escapeLogValue } from '../shared/logger/log-value'
import { PlannedBonus, SubscriptionBonusService } from './subscription-bonus.service'

/**
 * ConfioPagos `status` to local status.
 *
 * `SUSPENDED` maps to `past_due`, not to a terminal status: access is cut on the first failed charge and
 * comes back if a later charge succeeds. `CANCELED` and `EXPIRED` are terminal on the provider side.
 *
 * Signup statuses (`PENDING_ACCEPTANCE`, `PROCESSING`) live in `CONFIO_ESTADOS_SIN_EFECTO` on purpose.
 * Do NOT map `PENDING_ACCEPTANCE` to `PENDING`: the trial signup also creates the Confio subscription and its
 * webhook can arrive before our row exists (see `SubscriptionService.startTrial`), so a redispatch would push
 * a live `trial` row, plan already in roles, back to `pending`. Only our signup endpoint writes `pending`.
 * Guarded by `it.each(['PENDING_ACCEPTANCE', 'PROCESSING'])` in `webhook.service.spec.ts`.
 */
export const CONFIO_SUBSCRIPTION_STATUS_MAP: {
  [K in ConfioSubscriptionStatus]?: SubscriptionStatus
} = {
  TRIALING: SubscriptionStatus.TRIAL,
  ACTIVE: SubscriptionStatus.ACTIVE,
  PAST_DUE: SubscriptionStatus.PAST_DUE,
  SUSPENDED: SubscriptionStatus.PAST_DUE,
  CANCELED: SubscriptionStatus.CANCELLED,
  EXPIRED: SubscriptionStatus.EXPIRED,
}

/** Signup statuses: they are logged and never change the local status. */
export const CONFIO_ESTADOS_SIN_EFECTO: ConfioSubscriptionStatusWire[] = [
  'PENDING_ACCEPTANCE',
  'PROCESSING',
]

/**
 * Statuses ConfioPagos uses for a subscription already accepted and running (trial or paid cycle).
 * They are the only ones that grant the plan in `backend-roles`; signup grants nothing.
 *
 * Must stay disjoint from `CONFIO_ESTADOS_SIN_EFECTO`: `PENDING_ACCEPTANCE` means the buyer has not accepted
 * yet, and adding it here would grant the plan to someone with no card on file.
 */
export const CONFIO_ESTADOS_QUE_OTORGAN: ConfioSubscriptionStatus[] = ['TRIALING', 'ACTIVE']

/**
 * Statuses with which ConfioPagos declares its subscription dead: it will never charge or accept it.
 *
 * Active confirmation applies them to a row still waiting, the only status write that path allows. Reviving
 * from a poll would claim an authority we lack, but closing what the owner closed is monotonic (it grants
 * nothing and charges nothing) and stops endless polling of a signup nobody will pay.
 */
export const CONFIO_ESTADOS_MUERTOS: ConfioSubscriptionStatus[] = ['CANCELED', 'EXPIRED']

/**
 * `subscription_events.eventType` is a Postgres enum without a generic `status_changed`, so each status maps
 * to the closest member; the exact Confio event name stays in `metadata.event`.
 *
 * Only statuses with a single meaning belong here. `TRIALING` and `ACTIVE` are left out on purpose: their
 * event depends on whether the plan was granted, which `planearOtorgamiento` decides
 * (`CONFIRMATION_GRANTED`/`CONFIRMATION_NOT_GRANTED`). Adding them would record a first confirmation as
 * `reactivated`.
 */
const CONFIO_TIPO_DE_EVENTO: { [K in ConfioSubscriptionStatus]?: SubscriptionEventType } = {
  PAST_DUE: SubscriptionEventType.PAYMENT_FAILED,
  SUSPENDED: SubscriptionEventType.PAYMENT_FAILED,
  CANCELED: SubscriptionEventType.CANCELLED,
  EXPIRED: SubscriptionEventType.EXPIRED,
}

/** Canonical UUID: `subscriptions.id`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Our terminal statuses: reviving them deserves a warning. Mirrors `TERMINAL_SUBSCRIPTION_STATUSES`
 * (`subscription.entity.ts`).
 *
 * `pending` must NOT be added: `planearCobro` uses this to detect a resurrection, and the first charge of a
 * paid signup is not one. With `pending` here the row would become `active` without the plan in roles, so the
 * brand pays and gets nothing.
 */
const ESTADOS_TERMINALES = [SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED]

/**
 * `event` recorded in the history for an ACTIVE confirmation. It is not a ConfioPagos event, so readers of
 * `subscription_events` can tell "they notified us" from "we asked".
 */
export const CONFIRMACION_ACTIVA = 'subscription.confirmacionActiva'

/**
 * Outcome of asking ConfioPagos. Outcomes stay separate on purpose: the caller counts them differently, and a
 * channel failure must never become a fact about the subscription.
 */
export interface ResultadoDeConfirmacion {
  resultado: /** Applied: the row is live and the plan assigned in roles. */
    | 'otorgada'
    /** The buyer has not completed payment yet. The NORMAL case, not an error. */
    | 'sin_confirmar'
    /** Already applied, or the guards prevent it (terminal row, pending cancellation). */
    | 'sin_efecto'
    /** The provider declared it dead and the row was closed: polling stops. */
    | 'cerrada'
    /** The row has no ConfioPagos subscription to query. */
    | 'sin_suscripcion_en_el_proveedor'
    /** Could not ask. Does NOT mean "not accepted". */
    | 'proveedor_no_disponible'
  estadoRemoto?: string
}

/** Is the row already at the period end that is about to be written? */
function mismoFinDePeriodo(sub: Subscription, periodo: PeriodoConfio): boolean {
  const actual = aFecha(sub.currentPeriodEnd)

  return !!actual && actual.getTime() === periodo.end.getTime()
}

/**
 * Does the row have a cancellation of OURS still running?
 *
 * The `accessEndsAt` invariant (`subscription.entity.ts`): local stamp plus paid access not yet expired.
 * Cancelling does not move `status` (the row stays `trial`/`active`/`past_due` while we owe service), so
 * `ESTADOS_TERMINALES.includes(sub.status)` alone misses a subscription ConfioPagos already cancelled.
 * Both guards use it: ignoring the echo of our own cancellation, and blocking revival by a late charge.
 *
 * It discriminates by date: once access expires the row is an ordinary terminal case again. The date goes
 * through `aFecha`, so a column that is not a `Date` (or an `Invalid Date`) reads as "nothing pending" and
 * never crashes the handler.
 */
function bajaPendiente(sub: Subscription): boolean {
  const finDeAcceso = aFecha(sub.accessEndsAt)

  return !!sub.cancelledAt && !!finDeAcceso && !estaVencido(finDeAcceso)
}

/**
 * The row is already cancelled on OUR side, with or without access ahead.
 *
 * Wider than `bajaPendiente` on purpose: the stamp alone is enough. It also covers a cancellation whose access
 * already expired and one on a `pending` row, which never had access. ConfioPagos sends a `FAILED`
 * `billingStatusChanged` right after a `pending` subscription is cancelled, and without this `planearCobro`
 * would move the row to `past_due`: a cancellation shown as a live debtor.
 */
function yaDadaDeBaja(sub: Subscription): boolean {
  return ESTADOS_TERMINALES.includes(sub.status) || !!sub.cancelledAt
}

/**
 * Effect of a webhook, decided before touching the database. Computed outside the transaction (including the
 * provider call, which is network) and applied inside on the LOCKED row, so a transaction is never held open
 * across the network.
 */
interface EfectoConfio {
  eventType: SubscriptionEventType
  toStatus: SubscriptionStatus
  /** Only a successful charge advances the period. */
  avanzaPeriodo?: boolean
  /** Period of the charge: the provider one, or the local advance. */
  periodo?: PeriodoConfio
  reiniciaReintentos?: boolean
  /** `CANCELED` stamps `cancelledAt`, only if it was null. */
  sellaCancelacion?: boolean
  /**
   * A TRIAL confirmation writes `trialStart`/`trialEnd`, only when empty: a renewal does not rewrite when the
   * trial started.
   */
  sellaPrueba?: boolean
  /** Access move in `backend-roles`; absent means roles is not touched. */
  roles?: EfectoRoles
  /**
   * Value for the `reason` column when the payload brings none: the fact that downgraded must be identifiable
   * from the row alone.
   */
  reason?: string
}

/**
 * What a signed notice did: `out_of_order` when it is older than the one already applied to its
 * subscription, `no_effect` when the guards decided nothing applies.
 */
export type ConfioNoticeOutcome = 'applied' | 'out_of_order' | 'no_effect'

/**
 * Access move in `backend-roles`, decided BEFORE touching the database.
 *
 * Carries its own `brandId` and `planSlug` instead of rereading the locked row, so what was pushed to roles
 * and what `metadata` records are the same data even if another write changes the row plan meanwhile.
 */
interface EfectoRoles {
  /**
   * `retirar` is delinquency (removes the paid plan only), `degradar` is the final cancellation (removes it
   * and leaves `free`), and `reponer` is a successful charge.
   */
  accion: 'retirar' | 'reponer' | 'degradar'
  brandId: string
  planSlug: string
  /** Restore only: end of the period just charged. */
  expiresAt?: Date
}

/**
 * Handler of the SIGNED branch of the ConfioPagos webhook: the two `subscription.*` events, routed by
 * `webhook.service.ts`.
 *
 * No path here throws for a business fact (unresolved subscription, unmapped status, effect already applied):
 * it logs and returns, so `processEvent` marks the event `processed` and the endpoint answers 200. Real
 * database errors propagate so the queue retries.
 *
 * It throws only when `backend-roles` rejects the access move, a CHANNEL failure and not a fact
 * about the subscription. It throws before the transaction, so the row, the marker and the applied
 * history stay as they were and only the `pending` trace is left, for the retry to apply. Not
 * receiving the webhook removes nothing either.
 *
 * Two DIFFERENT notices of one subscription are ordered by `providerWatermark`
 * (`confio-watermark.util.ts`): an older one is checked before planning and again on the locked row,
 * and is kept as `out_of_order` without writing. The same notice twice is resolved by the marker,
 * read again under `pessimistic_write`. Before backend-roles is called the movement trace is written
 * `pending`, so a rejected call leaves it; `aplicar` turns it `applied`.
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
    private readonly bonus: SubscriptionBonusService,
  ) {}

  async handle(event: WebhookEvent): Promise<ConfioNoticeOutcome> {
    const payload: ConfioWebhookPayload = event?.payload || {}
    const data = payload.data || {}

    const sub = await this.resolverSuscripcion(data)
    if (!sub) {
      this.logger.warn(
        `Confio suscripción no resuelta: name=${escapeLogValue(data.name)} ` +
          `correlationId=${escapeLogValue(data.correlationId)}`,
      )
      return 'no_effect'
    }

    const markerIds = [
      event.providerEventId,
      buildLegacyConfioStatusChangedEventId(payload),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0)

    // Redispatch shortcut that saves a provider call; the guarantee is the reread under lock in `aplicar`.
    const yaAplicado = await ConfioSubscriptionWebhookService.buscarMarcador(
      this.subscriptionEventRepository.createQueryBuilder('e'),
      sub.id,
      markerIds,
    )
    if (yaAplicado) {
      this.logger.log(`Confio efecto ya aplicado para ${event.providerEventId}, no se repite`)
      return 'no_effect'
    }

    // Before planning, so an older notice reaches neither ConfioPagos nor backend-roles.
    const order = readNoticeOrder(payload)
    if (isOutOfOrder(sub, order)) {
      this.logger.log(
        `Confio notice ${escapeLogValue(event.providerEventId)} for ${sub.id} ` +
          'is out of order: not applied',
      )
      await this.discardPendingTrace(sub.id, event.providerEventId, 'out of order')
      return 'out_of_order'
    }

    const efecto =
      payload.event === 'subscription.billingStatusChanged'
        ? await this.planearCobro(data, sub)
        : await this.planearCambioDeEstado(data, sub)
    if (!efecto) {
      await this.discardPendingTrace(sub.id, event.providerEventId, 'no effect on retry')
      return 'no_effect'
    }

    // Before the bonus too: its plan catalog is also read from backend-roles.
    if (efecto.roles) await this.writePendingTrace(sub, efecto, payload, event.providerEventId)

    try {
      // Only a paid cycle that restores the plan gives the bonus; a late charge on a dead row does not.
      const plannedBonus =
        efecto.eventType === SubscriptionEventType.PAYMENT_SUCCEEDED && efecto.roles
          ? await this.bonus.plan(payload, sub)
          : null

      if (efecto.roles) {
        await this.sincronizarAccesoEnRoles(efecto.roles, sub.id, event.providerEventId)
      }

      return await this.aplicar(
        sub.id,
        efecto,
        payload,
        event.providerEventId,
        markerIds,
        plannedBonus,
        order,
      )
    } catch (error) {
      if (efecto.roles) {
        this.logger.warn(
          `Confio notice ${escapeLogValue(event.providerEventId)} left its trace pending ` +
            `for ${sub.id}: ${error?.message}`,
        )
      }
      throw error
    }
  }

  /**
   * The movement trace written before backend-roles is called, from the unlocked row. Without the
   * signature digest, which the cycle bonus reads as an applied notice. A second dispatch of the same
   * notice keeps the first one (`UQ_subscription_events_pending_trace`).
   */
  private async writePendingTrace(
    sub: Subscription,
    efecto: EfectoConfio,
    payload: ConfioWebhookPayload,
    providerEventId: string,
  ): Promise<void> {
    const trace = armarTrazaDelMovimiento({
      sub,
      fromStatus: sub.status,
      eventType: efecto.eventType,
      toStatus: efecto.toStatus,
      payload,
      providerEventId,
      roles: efecto.roles,
      reason: efecto.reason,
    })
    const metadata = { ...trace.metadata }
    delete metadata.signatureChecksum

    await this.subscriptionEventRepository
      .createQueryBuilder()
      .insert()
      .into(SubscriptionEvent)
      .values({ ...trace, metadata, traceStatus: SubscriptionTraceStatus.PENDING })
      .orIgnore()
      .execute()
  }

  /** A pending trace of `providerEventId` that a later delivery decided not to apply. */
  private async discardPendingTrace(
    subscriptionId: string,
    providerEventId: string,
    why: string,
    manager?: EntityManager,
  ): Promise<void> {
    const qb = manager
      ? manager.createQueryBuilder()
      : this.subscriptionEventRepository.createQueryBuilder()
    await qb
      .update(SubscriptionEvent)
      .set({ traceStatus: SubscriptionTraceStatus.DISCARDED, reason: `Discarded: ${why}` })
      .where('"subscriptionId" = :sid', { sid: subscriptionId })
      .andWhere("metadata ->> 'providerEventId' = :pid", { pid: providerEventId })
      .andWhere('"traceStatus" = :pending', { pending: SubscriptionTraceStatus.PENDING })
      .execute()
  }

  /**
   * Resolves by resource name, then by `correlationId` when it is a UUID (our `subscriptions.id`).
   *
   * Both `findOne` calls are guarded against `undefined` ON PURPOSE: TypeORM drops a condition whose value
   * is `undefined` and would return ANY subscription, a silent cross-brand write.
   *
   * Reads from the write connection so replica lag cannot apply here.
   */
  private async resolverSuscripcion(
    data: ConfioWebhookPayload['data'],
  ): Promise<Subscription | null> {
    if (
      typeof data?.name === 'string' &&
      data.name.length > 0 &&
      data.name.length <= MAX_CONFIO_STRING_LENGTH
    ) {
      const porNombre = await this.subscriptionRepository.findOne({
        where: {
          provider: SubscriptionProvider.CONFIO,
          providerSubscriptionId: data.name,
        },
      })
      if (
        porNombre &&
        porNombre.provider === SubscriptionProvider.CONFIO &&
        porNombre.providerSubscriptionId === data.name
      ) {
        return porNombre
      }
    }

    const correlationId = data?.correlationId
    if (typeof correlationId === 'string' && UUID_RE.test(correlationId)) {
      const porId = await this.subscriptionRepository.findOne({
        where: { id: correlationId, provider: SubscriptionProvider.CONFIO },
      })
      if (
        porId &&
        porId.provider === SubscriptionProvider.CONFIO &&
        (!porId.providerSubscriptionId || !data?.name || porId.providerSubscriptionId === data.name)
      ) {
        return porId
      }
    }

    return null
  }

  /** Cycle charge: `SUCCEEDED` renews; any other status means delinquency. */
  private async planearCobro(
    data: ConfioWebhookPayload['data'],
    sub: Subscription,
  ): Promise<EfectoConfio | null> {
    if (data?.status !== 'SUCCEEDED') {
      // Any non-`SUCCEEDED` status is unpaid, with no grace; a new intermediate Confio status would be too.
      // On a row we already cancelled it does nothing: `past_due` would turn a cancellation into a live debt.
      if (yaDadaDeBaja(sub)) {
        this.logger.log(
          `Confio cobro no exitoso sobre una suscripción ya dada de baja (${sub.id}): ` +
            `sin efecto, status=${escapeLogValue(data?.status)}`,
        )

        return null
      }

      // `past_due` makes `retryFailedPayments` issue and notify a new payment link, so a signup
      // that was never activated would get a second link for its first period.
      if (sub.status === SubscriptionStatus.PENDING) {
        this.logger.log(
          `Confio failed charge on a still pending subscription (${sub.id}): ` +
            `no effect, status=${escapeLogValue(data?.status)}`,
        )

        return null
      }

      this.logger.warn(
        `Confio cobro no exitoso para ${sub.id}: status=${escapeLogValue(data?.status)}`,
      )
      return {
        eventType: SubscriptionEventType.PAYMENT_FAILED,
        toStatus: SubscriptionStatus.PAST_DUE,
        roles: this.efectoRoles('retirar', sub),
      }
    }

    // Resolved once, here: the `expiresAt` promised to roles must equal the `currentPeriodEnd` persisted later.
    const periodo = (await this.leerPeriodoDelProveedor(data, sub)) || periodoLocal(sub)

    // A late `SUCCEEDED` on a row we treat as dead (terminal, or cancellation pending) does not restore the plan.
    // A `pending` row is excluded on purpose: that is its first charge and must restore the plan in roles.
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
   * Roles descriptor, or `undefined` when the row lacks the data. `brandId`/`planSlug` go into the roles path,
   * and an empty one returns 404, read as a channel failure that would retry forever.
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
   * Pushes the access move to `backend-roles`.
   *
   * (1) Branches on the BOOLEAN, not on a throw: `callRolesApi` catches 4xx, 5xx, timeouts and a missing
   *     `SERVICE_ROLES` and returns `false`, so a rollback written for "rejected" would miss a roles outage.
   * (2) Called BEFORE the transaction: it is HTTP with a 10 s timeout and would hold the row lock meanwhile.
   * (3) Throwing leaves only the `pending` trace: a channel down is never recorded as unpaid
   *     nor downgrades on its own. The message stays in `webhook_events.error` and the event is
   *     marked for retry, which today does not reprocess by itself (`webhook.processor.ts` counts
   *     and rethrows): the repair is `POST /webhook/:id/retry`. Debt of every provider.
   * (4) `degradar` delegates to `plan-downgrade.util.ts`, the single owner of that move (shared with the
   *     `tasks.service.ts` crons): it removes the paid plan and leaves `free` without `expiresAt`.
   * (5) Restoring uses `assignPlanToBrand`, NEVER `renewPlanForBrand`: assign is an upsert, while renew
   *     returns 404 when the brand lacks the plan, which is exactly the state a removal leaves.
   *
   * `callRolesApi` collapses 404 and 503 into the same `false`, so a plan missing from the roles catalog reads
   * as a channel outage and the event ends in dead letter after 3 attempts: loud, as a config error should be.
   */
  private async sincronizarAccesoEnRoles(
    roles: EfectoRoles,
    subscriptionId: string,
    providerEventId: string,
  ): Promise<void> {
    const traza = `brand=${roles.brandId} plan=${roles.planSlug} sub=${subscriptionId} event=${providerEventId}`

    const ok =
      roles.accion === 'degradar'
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
   * Period according to ConfioPagos, or `undefined` to advance locally.
   *
   * The resource name comes from the row or, failing that, `data.name`: `ConfioProvider.toSubscriptionPath`
   * rejects an empty name, and that failure would read as Confio being down.
   *
   * Each date is validated: `ConfioSubscriptionResult` declares them required, but they arrive `undefined`
   * until the subscription opens a period, and `strictNullChecks: false` hides it from the compiler.
   */
  private async leerPeriodoDelProveedor(
    data: ConfioWebhookPayload['data'],
    sub: Subscription,
    yaLeida?: ConfioSubscriptionResult,
  ): Promise<PeriodoConfio | undefined> {
    const resourceName = sub.providerSubscriptionId || data?.name
    if (!resourceName) {
      this.logger.warn(
        `Confio sin resource name para ${sub.id}: se avanza un ciclo local (no es un fallo del proveedor)`,
      )
      return undefined
    }

    try {
      // `yaLeida` reuses the read that brought the status in active confirmation, so the provider is asked once.
      const remota = yaLeida || (await this.confio.getSubscription(resourceName))
      const start = aFecha(remota?.currentPeriodStart)
      const end = aFecha(remota?.currentPeriodEnd)
      const nextBilling = aFecha(remota?.nextBillingTime)

      if (start && end && nextBilling) {
        // An expired period is useless as `expiresAt` (roles sweeps it) and as `nextBillingDate` (MONEY),
        // so fall back to the local advance, which is floored at now (`confio-period.util.ts`).
        if (!estaVencido(end)) return { start, end, nextBilling }

        this.logger.warn(
          `Confio devolvió un período ya vencido para ${sub.id} (fin=${end.toISOString()}): ` +
            'se avanza un ciclo local',
        )
        return undefined
      }

      this.logger.warn(
        `Confio devolvió un período incompleto para ${sub.id} (fuente=${
          sub.providerSubscriptionId ? 'providerSubscriptionId' : 'data.name'
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
   * Subscription status change; `null` means nothing to apply. Async because `TRIALING`/`ACTIVE` need the
   * provider period (network); still computed outside the transaction.
   */
  private async planearCambioDeEstado(
    data: ConfioWebhookPayload['data'],
    sub: Subscription,
  ): Promise<EfectoConfio | null> {
    const wire: ConfioSubscriptionStatusWire = data?.status || ''

    if (CONFIO_ESTADOS_SIN_EFECTO.includes(wire)) {
      this.logger.log(
        `Confio estado del alta ignorado: ${escapeLogValue(wire)} (${escapeLogValue(data?.name)})`,
      )
      return null
    }

    // `wire` is network text: an unknown status falls through as unmapped, and `hasOwnProperty` stops
    // `"constructor"`/`"valueOf"` from returning an inherited function that would land in `sub.status`.
    const mapeado = Object.prototype.hasOwnProperty.call(CONFIO_SUBSCRIPTION_STATUS_MAP, wire)
    const toStatus = mapeado
      ? CONFIO_SUBSCRIPTION_STATUS_MAP[wire as ConfioSubscriptionStatus]
      : undefined
    if (!toStatus) {
      this.logger.warn(
        `Confio estado no mapeado: ${escapeLogValue(wire)} (${escapeLogValue(data?.name)})`,
      )
      return null
    }

    // Idempotent by TERMINAL status, not just `providerEventId`: CANCELED then EXPIRED are two distinct events,
    // and a late terminal after a restoring `SUCCEEDED` would strip a plan the brand just paid for.
    if (ESTADOS_TERMINALES.includes(toStatus) && ESTADOS_TERMINALES.includes(sub.status)) {
      this.logger.log(
        `Confio ${wire} sobre una suscripción ya ${sub.status} (${sub.id}): sin efecto, ya está de baja`,
      )
      return null
    }

    const esTerminal = ESTADOS_TERMINALES.includes(toStatus)

    // R27: three distinct harms, and the third is not visible from this line.
    // ECHO of our own cancellation: while paid access remains, applying it would downgrade early, record a second
    // CANCELLED, and leave `cancelled` with a non-null `accessEndsAt` that the sweeping cron downgrades again.
    if (esTerminal && bajaPendiente(sub)) {
      this.logger.log(
        `Confio ${wire} sobre la baja que ya registramos (${sub.id}): sin efecto, ` +
          `el acceso pagado corre hasta ${aFecha(sub.accessEndsAt).toISOString()}`,
      )
      return null
    }

    // The CONFIRMATION grants access: `TRIALING`/`ACTIVE` are the only moment a signup gets the plan.
    if (CONFIO_ESTADOS_QUE_OTORGAN.includes(wire as ConfioSubscriptionStatus)) {
      return await this.planearOtorgamiento(data, sub, wire as ConfioSubscriptionStatus, toStatus)
    }

    // Delinquency (`PAST_DUE`/`SUSPENDED`) is recoverable: only the paid plan is removed. Terminal statuses
    // (`CANCELED`/`EXPIRED`) can never be charged again, so the brand drops to `free`.
    const roles = esTerminal
      ? this.efectoRoles('degradar', sub)
      : toStatus === SubscriptionStatus.PAST_DUE
        ? this.efectoRoles('retirar', sub)
        : undefined

    return {
      eventType: CONFIO_TIPO_DE_EVENTO[wire as ConfioSubscriptionStatus],
      toStatus,
      sellaCancelacion: toStatus === SubscriptionStatus.CANCELLED,
      // The downgrading fact, readable from the history row without the payload.
      ...(esTerminal ? { reason: `ConfioPagos reportó la suscripción ${wire}` } : {}),
      ...(roles ? { roles } : {}),
    }
  }

  /**
   * The subscription was accepted on the ConfioPagos side: this is where the brand gets access.
   *
   * The `expiresAt` promised to roles and the persisted `currentPeriodEnd` are the same object, resolved once.
   * The fallback depends on what was confirmed: `ACTIVE` is a paid cycle (`periodoLocal`); `TRIALING` uses
   * `periodoDePrueba`, which respects the stamped `trialEnd` (the monthly period would gift extra days).
   * Without a usable period nothing is granted and the status does not move, so the sweep retries it; the
   * cause goes to the trace `reason` column.
   *
   * The webhook, active confirmation and the sweep all pass here, so the event names the OUTCOME:
   * `CONFIRMATION_GRANTED` when the brand ended with access, `CONFIRMATION_NOT_GRANTED` otherwise. It never
   * comes from `CONFIO_TIPO_DE_EVENTO`: the provider status is the same `TRIALING` in every exit.
   */
  private async planearOtorgamiento(
    data: ConfioWebhookPayload['data'],
    sub: Subscription,
    wire: ConfioSubscriptionStatus,
    toStatus: SubscriptionStatus,
    yaLeida?: ConfioSubscriptionResult,
  ): Promise<EfectoConfio | null> {
    // The outcome sets the event: not-granted is the floor every non-granting exit inherits, and only the
    // grant overrides it.
    const efecto: EfectoConfio = {
      eventType: SubscriptionEventType.CONFIRMATION_NOT_GRANTED,
      toStatus,
    }

    // Same resurrection guard as `planearCobro`: a late confirmation on a row dead on our side (or with a
    // pending cancellation) applies the status but does not buy the plan again.
    if (ESTADOS_TERMINALES.includes(sub.status) || bajaPendiente(sub)) {
      this.logger.warn(
        `Confio ${wire} sobre una suscripción que dimos por muerta (${sub.id}, ${sub.status}): ` +
          'se aplica el estado pero NO se otorga el plan en roles',
      )
      return efecto
    }

    const periodo =
      (await this.leerPeriodoDelProveedor(data, sub, yaLeida)) ||
      (toStatus === SubscriptionStatus.TRIAL ? periodoDePrueba(sub) : periodoLocal(sub))
    if (!periodo) {
      this.logger.warn(
        `Confio ${wire} para ${sub.id} sin período utilizable (trialEnd=${sub.trialEnd}): ` +
          'NO se otorga el plan en roles y la fila se deja donde el barrido la alcance',
      )

      // The status does NOT move: the sweep looks for `PENDING` rows, so moving it would drop a paid signup
      // with no access from any retry. Returning `null` would lose the `reason` the trace keeps.
      return {
        ...efecto,
        toStatus: sub.status,
        reason:
          `Confio confirmó ${wire} pero no hay período utilizable ` +
          `(trialEnd=${aFecha(sub.trialEnd)?.toISOString() ?? 'sin fecha utilizable'}): ` +
          'no se otorgó acceso y la suscripción queda pendiente de confirmar',
      }
    }

    // Same fact already applied: the confirmation paths cannot share idempotency keys, so status and period end
    // are compared. A renewal (same status, new period) still passes.
    if (sub.status === toStatus && mismoFinDePeriodo(sub, periodo)) {
      this.logger.log(
        `Confio ${wire} para ${sub.id} ya estaba aplicado (mismo estado y mismo período): sin efecto`,
      )
      return null
    }

    const roles = this.efectoRoles('reponer', sub, periodo.end)

    // The TRIAL is stamped here, not at signup, so an unpaid subscription never shows access or counts as a
    // used trial. Only when empty (a renewal must not rewrite it), with the provider period.
    const sellaPrueba = toStatus === SubscriptionStatus.TRIAL && !sub.trialStart

    // The ONLY writer of `CONFIRMATION_GRANTED`: it cannot be recorded without a resolved period and roles effect.
    return {
      ...efecto,
      eventType: SubscriptionEventType.CONFIRMATION_GRANTED,
      avanzaPeriodo: true,
      periodo,
      ...(sellaPrueba ? { sellaPrueba: true } : {}),
      ...(roles ? { roles } : {}),
    }
  }

  /**
   * ACTIVE confirmation: instead of waiting for the notification, asks ConfioPagos and applies the same effect,
   * because the webhook cannot be the only way to learn of a payment. Used by `POST /subscription/confirm` and
   * the recovery sweep.
   *
   * It does not reimplement the rule: it builds the `data` a notification would bring and goes through
   * `planearOtorgamiento` (same guards), `sincronizarAccesoEnRoles` and `aplicar`. One provider read, reused
   * for the period. A roles `throw` propagates as in the webhook: a channel down is never recorded as a fact.
   */
  async confirmarContraElProveedor(sub: Subscription): Promise<ResultadoDeConfirmacion> {
    const resourceName = sub.metadata?.confio?.name || sub.providerSubscriptionId
    if (!resourceName) return { resultado: 'sin_suscripcion_en_el_proveedor' }

    let remota: ConfioSubscriptionResult
    try {
      remota = await this.confio.getSubscription(resourceName)
    } catch (error) {
      // A channel failure is not a fact about the subscription (neither "not accepted" nor a cancellation).
      this.logger.warn(`Confio no respondió el estado de ${sub.id}: ${error?.message}`)
      return { resultado: 'proveedor_no_disponible' }
    }

    const wire = String(remota?.status || '') as ConfioSubscriptionStatus

    // A signup ConfioPagos declared dead is CLOSED, or the sweep would poll it until the window ends. Roles is
    // left alone: a row awaiting confirmation never had a plan to remove.
    if (CONFIO_ESTADOS_MUERTOS.includes(wire) && sub.status === SubscriptionStatus.PENDING) {
      const toStatus = CONFIO_SUBSCRIPTION_STATUS_MAP[wire]
      const data = { name: resourceName, status: wire }
      await this.aplicar(
        sub.id,
        {
          eventType: CONFIO_TIPO_DE_EVENTO[wire],
          toStatus,
          sellaCancelacion: toStatus === SubscriptionStatus.CANCELLED,
          reason: `ConfioPagos reportó la suscripción ${wire} sin que se completara el pago`,
        },
        { event: CONFIRMACION_ACTIVA, data },
        `${resourceName}:confirmacion:${wire}`,
      )
      this.logger.log(
        `Confio dio por muerta el alta ${sub.id} (${wire}): se cierra y deja de repescarse`,
      )

      return { resultado: 'cerrada', estadoRemoto: wire }
    }

    if (!CONFIO_ESTADOS_QUE_OTORGAN.includes(wire)) {
      // The NORMAL case while the buyer has not completed payment. Not an error.
      return { resultado: 'sin_confirmar', estadoRemoto: wire }
    }

    const toStatus = CONFIO_SUBSCRIPTION_STATUS_MAP[wire]
    const data = { name: resourceName, status: wire }
    const efecto = await this.planearOtorgamiento(data, sub, wire, toStatus, remota)

    // This path writes ONLY when there is access to grant: a poll lacks the authority a notification has over
    // provider status, so without a roles effect nothing is written and the next pass (or the webhook) retries.
    if (!efecto || !efecto.roles) return { resultado: 'sin_efecto', estadoRemoto: wire }

    // Own marker: the `updateTime` Confio uses for its id is not in the query response. Double effects across
    // paths are prevented by the "same fact already applied" guard, not by this id.
    const providerEventId = `${resourceName}:confirmacion:${wire}:${efecto.periodo.end.toISOString()}`

    if (efecto.roles) {
      await this.sincronizarAccesoEnRoles(efecto.roles, sub.id, providerEventId)
    }
    await this.aplicar(sub.id, efecto, { event: CONFIRMACION_ACTIVA, data }, providerEventId)

    return { resultado: 'otorgada', estadoRemoto: wire }
  }

  /**
   * Atomic write: locked row, marker reread under that lock, status and history row.
   *
   * The reread HERE is the real idempotency guarantee: `retryWebhook` (admin) and the retry queue may dispatch
   * the SAME `WebhookEvent` at once. The patch is computed on the LOCKED row, not on the earlier copy.
   */
  private async aplicar(
    subscriptionId: string,
    efecto: EfectoConfio,
    payload: ConfioWebhookPayload,
    providerEventId: string,
    markerIds: string | string[] = providerEventId,
    bono: PlannedBonus | null = null,
    order?: NoticeOrder,
  ): Promise<ConfioNoticeOutcome> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const sub = await manager.findOne(Subscription, {
        where: { id: subscriptionId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!sub) return 'no_effect'

      const marcador = await ConfioSubscriptionWebhookService.buscarMarcador(
        manager.createQueryBuilder(SubscriptionEvent, 'e'),
        subscriptionId,
        markerIds,
      )
      if (marcador) {
        this.logger.log(
          `Confio efecto ya aplicado (bajo lock) para ${providerEventId}, no se repite`,
        )
        return 'no_effect'
      }

      // The guarantee: a newer notice may have been applied since the unlocked check.
      if (order && isOutOfOrder(sub, order)) {
        await this.discardPendingTrace(subscriptionId, providerEventId, 'out of order', manager)
        const roles = efecto.roles
        if (roles) {
          this.logger.warn(
            `Confio notice ${escapeLogValue(providerEventId)} lost the order under lock ` +
              `after backend-roles ran: ${roles.accion} brand=${roles.brandId} plan=${roles.planSlug} sub=${subscriptionId}`,
          )
        }
        return 'out_of_order'
      }

      const fromStatus = sub.status
      // Resurrection: the mapping is applied, but a late delivery may return something cancelled to `active`.
      if (ESTADOS_TERMINALES.includes(fromStatus) && efecto.toStatus !== fromStatus) {
        this.logger.warn(
          `Confio reactiva una suscripción en estado terminal: ${subscriptionId} ${fromStatus} → ${efecto.toStatus}`,
        )
      }

      sub.status = efecto.toStatus
      if (efecto.reiniciaReintentos) sub.retryCount = 0
      if (efecto.sellaCancelacion && !sub.cancelledAt) sub.cancelledAt = new Date()
      // MONEY: a terminal row with `autoRenew` on stays eligible for renewal and retry charges. Same predicate
      // as `degradar`, so the two cannot diverge.
      if (ESTADOS_TERMINALES.includes(efecto.toStatus)) sub.autoRenew = false
      // MONEY: `nextBillingDate` drives `processSubscriptionRenewals`, which renews what ConfioPagos already charges.
      if (efecto.avanzaPeriodo) ConfioSubscriptionWebhookService.avanzarPeriodo(sub, efecto.periodo)
      // The trial period is the cycle period, as the provider reports it.
      if (efecto.sellaPrueba && !sub.trialStart) {
        sub.trialStart = efecto.periodo.start
        sub.trialEnd = efecto.periodo.end
      }
      if (order) sub.providerWatermark = advanceMark(sub, order)

      await manager.save(sub)
      if (bono) await this.bonus.credit(manager, bono, sub)

      const pendingTrace = await manager
        .createQueryBuilder(SubscriptionEvent, 'e')
        .where('e."subscriptionId" = :sid', { sid: subscriptionId })
        .andWhere("e.metadata ->> 'providerEventId' = :pid", { pid: providerEventId })
        .andWhere('e."traceStatus" = :pending', { pending: SubscriptionTraceStatus.PENDING })
        .getOne()

      // The trace uses the `sub` just read UNDER LOCK: brand, user and plan come from that row.
      await manager.save(SubscriptionEvent, {
        ...armarTrazaDelMovimiento({
          sub,
          fromStatus,
          eventType: efecto.eventType,
          toStatus: efecto.toStatus,
          payload,
          providerEventId,
          roles: efecto.roles,
          reason: efecto.reason,
        }),
        ...(pendingTrace
          ? { id: pendingTrace.id, traceStatus: SubscriptionTraceStatus.APPLIED }
          : {}),
      })

      return 'applied'
    })
  }

  /**
   * Assigns the dates already resolved at decision time.
   *
   * The local fallback is computed on the UNLOCKED read: acceptable because the same event stays deduplicated
   * and distinct events are last-write-wins. The alternative is promising an `expiresAt` different from the
   * persisted one, or holding HTTP inside the transaction.
   */
  private static avanzarPeriodo(sub: Subscription, periodo: PeriodoConfio): void {
    sub.currentPeriodStart = periodo.start
    sub.currentPeriodEnd = periodo.end
    sub.nextBillingDate = periodo.nextBilling
  }

  /**
   * Applied-effect marker: the history row carrying this `providerEventId` in its `metadata`.
   *
   * Scoped by `subscriptionId` (indexed) and NEVER by a row window: `retryWebhook` can redispatch an
   * arbitrarily old event, and a marker outside a fixed window would grant a free period.
   */
  private static buscarMarcador(
    qb: SelectQueryBuilder<SubscriptionEvent>,
    subscriptionId: string,
    providerEventId: string | string[],
  ): Promise<SubscriptionEvent | null> {
    const ids = (Array.isArray(providerEventId) ? providerEventId : [providerEventId]).filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    )
    const uniqueIds = Array.from(new Set(ids))
    const applied = { applied: SubscriptionTraceStatus.APPLIED }
    if (uniqueIds.length <= 1) {
      return qb
        .where('e."subscriptionId" = :sid', { sid: subscriptionId })
        .andWhere("e.metadata ->> 'providerEventId' = :pid", { pid: uniqueIds[0] })
        .andWhere('e."traceStatus" = :applied', applied)
        .getOne()
    }
    return qb
      .where('e."subscriptionId" = :sid', { sid: subscriptionId })
      .andWhere("e.metadata ->> 'providerEventId' IN (:...pids)", { pids: uniqueIds })
      .andWhere('e."traceStatus" = :applied', applied)
      .getOne()
  }
}
