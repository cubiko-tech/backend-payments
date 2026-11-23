// R6: one responsibility, the crons that end a subscription; they share the roles downgrade.
import { Between, In, IsNull, LessThan, Not } from 'typeorm'

import { ClientRolesService } from '../client/client-roles.service'
import { downgradeBrandToFree, freePlanSlug } from '../client/plan-downgrade.util'
import { EventBusService } from '../event-bus/event-bus.service'
import { logger } from '../shared/logger/logger'
import {
  LIVE_SUBSCRIPTION_STATUSES,
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'
import { ConfioSubscriptionWebhookService } from '../webhook/confio-subscription-webhook.service'
import {
  closeEach,
  CloseOutcome,
  closeRow,
  SubscriptionCloseDeps,
  underRowLock,
} from './subscription-close'
import { SubscriptionLockRelease } from './subscription-lock'

export interface SubscriptionExpirationDeps extends SubscriptionCloseDeps {
  clientRoles: ClientRolesService
  eventBus: EventBusService
  confioWebhook: ConfioSubscriptionWebhookService
  MAX_RETRY: number
}

/**
 * How long a Confio trial whose signup link was issued waits past its billing date for the charge
 * notice before it ends as a trial without payment.
 */
export const MARKED_TRIAL_CHARGE_GRACE_HOURS = 24

async function expireLockedSubscription(
  sub: Subscription,
  deps: SubscriptionExpirationDeps,
): Promise<CloseOutcome> {
  return underRowLock(sub, deps, async (release) => {
    if (sub.status !== SubscriptionStatus.PAST_DUE || sub.retryCount < deps.MAX_RETRY) {
      return 'skipped'
    }

    // Downgrade in roles first so a rejected call leaves the row in PAST_DUE for the next pass.
    if (!(await degradeInRoles(sub, deps))) {
      await stopRecurringBilling(sub, deps)
      return 'rejected'
    }

    // Compare-and-set on PAST_DUE prevents duplicate events and clears any pending cancellation date.
    const vencida = await closeRow(
      release,
      deps,
      { id: sub.id, status: SubscriptionStatus.PAST_DUE },
      { status: SubscriptionStatus.EXPIRED, autoRenew: false, accessEndsAt: null },
      {
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.EXPIRED,
        fromStatus: SubscriptionStatus.PAST_DUE,
        toStatus: SubscriptionStatus.EXPIRED,
        triggeredBy: 'system',
        reason: `Reintentos de pago agotados (${deps.MAX_RETRY} intentos)`,
      },
    )
    if (!vencida) {
      logger.log(
        'info',
        `[CRON] Suscripción ${sub.id} ya no estaba en past_due: no se vence dos veces`,
      )
      return 'skipped'
    }
    await release()

    deps.eventBus.publishSubscriptionExpired({
      brandId: sub.brandId,
      subscriptionId: sub.id,
      planSlug: sub.planSlug,
    })

    logger.log('info', `[CRON] Suscripción expirada: brandId=${sub.brandId}`)
    return 'closed'
  })
}

/**
 * Downgrades to `free` and expires `past_due` subscriptions that exhausted their payment retries.
 */
export async function expireSubscriptions(deps: SubscriptionExpirationDeps): Promise<void> {
  const expired = await deps.subscriptionRepo.find({
    where: {
      status: SubscriptionStatus.PAST_DUE,
    },
  })

  const exhausted = expired.filter((sub) => sub.retryCount >= deps.MAX_RETRY)
  const { closed: count, rejected: rechazadas } = await closeEach(
    'expireSubscriptions',
    exhausted,
    (sub) => expireLockedSubscription(sub, deps),
    deps,
  )

  if (count > 0) {
    logger.log('info', `[CRON] expireSubscriptions: ${count} suscripciones expiradas`)
  }

  if (rechazadas > 0) {
    logger.log(
      'error',
      `[CRON] expireSubscriptions: ${rechazadas} sin vencer, backend-roles rechazó la degradación`,
    )
  }

  await endMarkedTrialsWithoutCharge(deps)
}

/**
 * Ends the Confio trials whose signup issued their only payment link and whose charge notice did
 * not arrive within `MARKED_TRIAL_CHARGE_GRACE_HOURS` of the billing date, as trials without payment.
 */
async function endMarkedTrialsWithoutCharge(deps: SubscriptionExpirationDeps): Promise<void> {
  const cutoff = new Date(Date.now() - MARKED_TRIAL_CHARGE_GRACE_HOURS * 60 * 60 * 1000)
  const isOverdue = (sub: Subscription) =>
    sub.status === SubscriptionStatus.TRIAL &&
    sub.autoRenew &&
    sub.provider !== SubscriptionProvider.WALLET &&
    !!sub.initialPaymentLinkIssuedAt &&
    !!sub.nextBillingDate &&
    new Date(sub.nextBillingDate) < cutoff
  const marked = await deps.subscriptionRepo.find({
    where: {
      status: SubscriptionStatus.TRIAL,
      autoRenew: true,
      provider: Not(SubscriptionProvider.WALLET),
      initialPaymentLinkIssuedAt: Not(IsNull()),
      nextBillingDate: LessThan(cutoff),
    },
  })

  const { closed, rejected } = await closeEach(
    'endMarkedTrialsWithoutCharge',
    marked.filter(isOverdue),
    (sub) =>
      underRowLock(sub, deps, async (release) => {
        if (!isOverdue(sub)) return 'skipped'
        return endTrialWithoutPayment(sub, deps, release)
      }),
    deps,
  )
  if (closed > 0 || rejected > 0) {
    logger.log(
      rejected > 0 ? 'error' : 'info',
      `[CRON] endMarkedTrialsWithoutCharge: ${closed} degradadas a ${freePlanSlug()}, ` +
        `${rejected} sin degradar, backend-roles rechazó la degradación`,
    )
  }
}

/**
 * Closes subscriptions whose deferred cancellation cut (`accessEndsAt`) has elapsed, downgrading
 * the brand to `free` in `backend-roles` before writing `cancelled` and restoring the paid plan if
 * the row was reactivated while the downgrade was in flight.
 */
export async function expireCancelledSubscriptions(
  deps: SubscriptionExpirationDeps,
): Promise<void> {
  const ahora = new Date()
  const bajaVencida = { autoRenew: false, accessEndsAt: LessThan(ahora) }
  const vencidas = await deps.subscriptionRepo.find({
    where: [
      { status: In([SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE]), ...bajaVencida },
      {
        status: SubscriptionStatus.PAST_DUE,
        retryCount: LessThan(deps.MAX_RETRY),
        ...bajaVencida,
      },
    ],
    order: { accessEndsAt: 'ASC' },
    take: 200,
  })

  const { closed: cerradas, rejected: rechazadas } = await closeEach(
    'expireCancelledSubscriptions',
    vencidas,
    (sub) => closeCancelledSubscription(sub, ahora, deps),
    deps,
  )

  if (cerradas > 0) {
    logger.log('info', `[CRON] expireCancelledSubscriptions: ${cerradas} suscripciones cerradas`)
  }

  if (rechazadas > 0) {
    logger.log(
      'error',
      `[CRON] expireCancelledSubscriptions: ${rechazadas} sin cerrar, backend-roles rechazó la degradación`,
    )
  }
}

function isDueCancellation(sub: Subscription, ahora: Date, deps: SubscriptionExpirationDeps) {
  const live =
    [SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE].includes(sub.status) ||
    // Exhausted past-due rows belong to expireSubscriptions.
    (sub.status === SubscriptionStatus.PAST_DUE && sub.retryCount < deps.MAX_RETRY)
  return live && !sub.autoRenew && !!sub.accessEndsAt && new Date(sub.accessEndsAt) < ahora
}

async function closeCancelledSubscription(
  sub: Subscription,
  ahora: Date,
  deps: SubscriptionExpirationDeps,
): Promise<CloseOutcome> {
  return underRowLock(sub, deps, async (release) => {
    if (!isDueCancellation(sub, ahora, deps)) return 'skipped'

    if (!(await degradeInRoles(sub, deps))) return 'rejected'

    const finDeAcceso = sub.accessEndsAt
    const cerrada = await closeRow(
      release,
      deps,
      { id: sub.id, status: sub.status, autoRenew: false, accessEndsAt: LessThan(ahora) },
      { status: SubscriptionStatus.CANCELLED, accessEndsAt: null },
      {
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.EXPIRED,
        fromStatus: sub.status,
        toStatus: SubscriptionStatus.CANCELLED,
        triggeredBy: 'system',
        reason: `Fin del acceso pagado tras la baja — degradado a ${freePlanSlug()}`,
        metadata: {
          event: 'subscription.access_ended',
          accessEndsAt: finDeAcceso ? new Date(finDeAcceso).toISOString() : null,
          brandId: sub.brandId,
          planSlug: sub.planSlug,
        },
      },
    )
    if (!cerrada) {
      await restorePlanIfStillEntitled(sub, ahora, deps)
      return 'skipped'
    }
    await release()

    deps.eventBus.publishSubscriptionExpired({
      brandId: sub.brandId,
      subscriptionId: sub.id,
      planSlug: sub.planSlug,
    })

    await deps.eventBus.notifySubscriptionExpired(sub.brandId, sub.planSlug)

    logger.log(
      'info',
      `[CRON] Acceso pagado terminado, marca en ${freePlanSlug()}: brandId=${sub.brandId}`,
    )
    return 'closed'
  })
}

/**
 * Sends expiration warnings 7, 3, 1, and 0 days before the end of paid access (`accessEndsAt` when
 * a deferred cancellation is set, or `currentPeriodEnd` for non-renewing active rows).
 */
export async function sendExpirationWarnings(deps: SubscriptionExpirationDeps): Promise<void> {
  const now = new Date()
  const warningDays = [7, 3, 1, 0]

  for (const days of warningDays) {
    const targetDate = new Date(now)
    targetDate.setDate(targetDate.getDate() + days)

    const rangeStart = new Date(targetDate)
    rangeStart.setHours(0, 0, 0, 0)
    const rangeEnd = new Date(targetDate)
    rangeEnd.setHours(23, 59, 59, 999)

    const porAccesoSellado = {
      status: In([
        SubscriptionStatus.TRIAL,
        SubscriptionStatus.ACTIVE,
        SubscriptionStatus.PAST_DUE,
      ]),
      autoRenew: false,
      accessEndsAt: Between(rangeStart, rangeEnd),
    }

    const porPeriodo = {
      status: In([SubscriptionStatus.ACTIVE]),
      autoRenew: false,
      accessEndsAt: IsNull(),
      currentPeriodEnd: Between(rangeStart, rangeEnd),
    }

    const subscriptions = await deps.subscriptionRepo.find({
      where: days === 0 ? [porPeriodo] : [porAccesoSellado, porPeriodo],
    })

    for (const sub of subscriptions) {
      if (days === 0) {
        await deps.eventBus.notifySubscriptionExpired(sub.brandId, sub.planSlug)
      } else {
        await deps.eventBus.notifySubscriptionExpiring(sub.brandId, sub.planSlug, String(days))
      }
    }

    if (subscriptions.length > 0) {
      logger.log(
        'info',
        `[CRON] sendExpirationWarnings: ${subscriptions.length} avisos enviados (${days} días)`,
      )
    }
  }
}

/**
 * Ends an expired trial without payment by downgrading the brand to `free` first. Runs under the
 * row's lock `release`, whose transaction takes the compare-and-set and its event, and commits it.
 */
export async function endTrialWithoutPayment(
  sub: Subscription,
  deps: SubscriptionExpirationDeps,
  release: SubscriptionLockRelease,
): Promise<CloseOutcome> {
  if (!(await degradeInRoles(sub, deps))) return 'rejected'

  const terminado = await closeRow(
    release,
    deps,
    { id: sub.id, status: SubscriptionStatus.TRIAL },
    { status: SubscriptionStatus.EXPIRED, autoRenew: false },
    {
      subscriptionId: sub.id,
      eventType: SubscriptionEventType.TRIAL_ENDED,
      fromStatus: SubscriptionStatus.TRIAL,
      toStatus: SubscriptionStatus.EXPIRED,
      triggeredBy: 'system',
      reason: `Trial vencido sin método de pago — degradado a ${freePlanSlug()}`,
    },
  )
  if (!terminado) {
    logger.log('info', `[CRON] Trial ${sub.id} ya no estaba en trial: no se degrada dos veces`)
    return 'skipped'
  }
  await release()

  deps.eventBus.publishSubscriptionExpired({
    brandId: sub.brandId,
    subscriptionId: sub.id,
    planSlug: sub.planSlug,
  })
  await deps.eventBus.notifySubscriptionExpired(sub.brandId, sub.planSlug)

  logger.log('info', `[CRON] Trial degradado a ${freePlanSlug()}: brandId=${sub.brandId}`)
  return 'closed'
}

async function degradeInRoles(
  sub: Subscription,
  deps: Pick<SubscriptionExpirationDeps, 'clientRoles'>,
): Promise<boolean> {
  if (!sub.brandId || !sub.planSlug) {
    logger.log(
      'error',
      `[CRON] Suscripción ${sub.id} sin brandId/planSlug: no se degrada en roles ` +
        `(brand=${sub.brandId} plan=${sub.planSlug})`,
    )
    return true
  }
  return downgradeBrandToFree(deps.clientRoles, sub.brandId, sub.planSlug)
}

async function restorePlanIfStillEntitled(
  sub: Subscription,
  ahora: Date,
  deps: Pick<SubscriptionExpirationDeps, 'subscriptionRepo' | 'clientRoles'>,
): Promise<void> {
  logger.log(
    'error',
    `[CRON] La suscripción ${sub.id} cambió mientras se degradaba en roles: el cierre no se aplicó`,
  )

  if (!sub.brandId || !sub.planSlug || sub.planSlug === freePlanSlug()) return

  const vigente = await deps.subscriptionRepo.findOne({ where: { id: sub.id } })
  const sigueConDerecho =
    !!vigente &&
    LIVE_SUBSCRIPTION_STATUSES.includes(vigente.status) &&
    (vigente.autoRenew || (!!vigente.accessEndsAt && vigente.accessEndsAt > ahora))
  if (!sigueConDerecho) return

  const repuesto = await deps.clientRoles.assignPlanToBrand(
    vigente.brandId,
    vigente.planSlug,
    vigente.currentPeriodEnd,
  )
  logger.log(
    repuesto ? 'info' : 'error',
    `[CRON] Plan ${vigente.planSlug} ${repuesto ? 'repuesto' : 'NO repuesto'} en backend-roles ` +
      `tras el cierre abortado: brandId=${vigente.brandId}`,
  )
}

async function stopRecurringBilling(
  sub: Subscription,
  deps: Pick<SubscriptionExpirationDeps, 'subscriptionRepo'>,
): Promise<void> {
  if (!sub.autoRenew) return
  await deps.subscriptionRepo.update({ id: sub.id }, { autoRenew: false })
  sub.autoRenew = false
  logger.log('info', `[CRON] Renovación apagada mientras se reintenta la degradación: ${sub.id}`)
}
