import { Between, In, IsNull, LessThan, Repository } from 'typeorm'

import { ClientRolesService } from '../client/client-roles.service'
import { downgradeBrandToFree, freePlanSlug } from '../client/plan-downgrade.util'
import { EventBusService } from '../event-bus/event-bus.service'
import { logger } from '../shared/logger/logger'
import {
  LIVE_SUBSCRIPTION_STATUSES,
  Subscription,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../subscription/entities/subscriptionEvent.entity'
import { ConfioSubscriptionWebhookService } from '../webhook/confio-subscription-webhook.service'
import { acquireSubscriptionLock, SubscriptionLockDeps } from './subscription-lock'

export interface SubscriptionExpirationDeps extends SubscriptionLockDeps {
  subscriptionEventRepo: Repository<SubscriptionEvent>
  clientRoles: ClientRolesService
  eventBus: EventBusService
  confioWebhook: ConfioSubscriptionWebhookService
  MAX_RETRY: number
}

async function expireLockedSubscription(
  sub: Subscription,
  deps: SubscriptionExpirationDeps,
): Promise<'expired' | 'rejected' | 'skipped'> {
  let releaseSubscriptionLock: (() => Promise<void>) | null = null
  try {
    releaseSubscriptionLock = await acquireSubscriptionLock(sub, deps)
    const fresh = await deps.subscriptionRepo.findOne?.({ where: { id: sub.id } })
    if (fresh) {
      Object.assign(sub, fresh)
    }
    if (sub.status !== SubscriptionStatus.PAST_DUE || sub.retryCount < deps.MAX_RETRY) {
      return 'skipped'
    }

    // Downgrade in roles first so a rejected call leaves the row in PAST_DUE for the next pass.
    if (!(await degradeInRoles(sub, deps))) {
      await stopRecurringBilling(sub, deps)
      return 'rejected'
    }

    // Compare-and-set on PAST_DUE prevents duplicate events and clears any pending cancellation date.
    const vencida = await deps.subscriptionRepo.update(
      { id: sub.id, status: SubscriptionStatus.PAST_DUE },
      { status: SubscriptionStatus.EXPIRED, autoRenew: false, accessEndsAt: null },
    )
    if (!vencida.affected) {
      logger.log(
        'info',
        `[CRON] Suscripción ${sub.id} ya no estaba en past_due: no se vence dos veces`,
      )
      return 'skipped'
    }

    await deps.subscriptionEventRepo.save(
      deps.subscriptionEventRepo.create({
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.EXPIRED,
        fromStatus: SubscriptionStatus.PAST_DUE,
        toStatus: SubscriptionStatus.EXPIRED,
        triggeredBy: 'system',
        reason: `Reintentos de pago agotados (${deps.MAX_RETRY} intentos)`,
      }),
    )

    deps.eventBus.publishSubscriptionExpired({
      brandId: sub.brandId,
      subscriptionId: sub.id,
      planSlug: sub.planSlug,
    })

    logger.log('info', `[CRON] Suscripción expirada: brandId=${sub.brandId}`)
    return 'expired'
  } finally {
    await releaseSubscriptionLock?.()
  }
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

  let count = 0
  let rechazadas = 0
  for (const sub of expired) {
    if (sub.retryCount < deps.MAX_RETRY) continue
    const outcome = await expireLockedSubscription(sub, deps)
    if (outcome === 'expired') {
      count++
    } else if (outcome === 'rejected') {
      rechazadas++
    }
  }

  if (count > 0) {
    logger.log('info', `[CRON] expireSubscriptions: ${count} suscripciones expiradas`)
  }

  if (rechazadas > 0) {
    logger.log(
      'error',
      `[CRON] expireSubscriptions: ${rechazadas} sin vencer, backend-roles rechazó la degradación`,
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

  let cerradas = 0
  let rechazadas = 0
  for (const sub of vencidas) {
    // Exhausted past-due rows belong to expireSubscriptions.
    if (sub.status === SubscriptionStatus.PAST_DUE && sub.retryCount >= deps.MAX_RETRY) continue

    if (!(await degradeInRoles(sub, deps))) {
      rechazadas++
      continue
    }

    const finDeAcceso = sub.accessEndsAt
    const cerrada = await deps.subscriptionRepo.update(
      { id: sub.id, status: sub.status, autoRenew: false, accessEndsAt: LessThan(ahora) },
      { status: SubscriptionStatus.CANCELLED, accessEndsAt: null },
    )
    if (!cerrada.affected) {
      await restorePlanIfStillEntitled(sub, ahora, deps)
      continue
    }

    await deps.subscriptionEventRepo.save(
      deps.subscriptionEventRepo.create({
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.EXPIRED,
        fromStatus: sub.status,
        toStatus: SubscriptionStatus.CANCELLED,
        triggeredBy: 'system',
        reason: `Fin del acceso pagado tras la baja — degradado a ${freePlanSlug()}`,
        metadata: {
          event: 'subscription.access_ended',
          accessEndsAt: finDeAcceso ? finDeAcceso.toISOString() : null,
          brandId: sub.brandId,
          planSlug: sub.planSlug,
        },
      }),
    )

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
    cerradas++
  }

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
 * Ends an expired wallet trial that has no payment method by downgrading the brand to `free` first.
 */
export async function endTrialWithoutPayment(
  sub: Subscription,
  deps: SubscriptionExpirationDeps,
): Promise<boolean> {
  if (!(await degradeInRoles(sub, deps))) return false

  const terminado = await deps.subscriptionRepo.update(
    { id: sub.id, status: SubscriptionStatus.TRIAL },
    { status: SubscriptionStatus.EXPIRED, autoRenew: false },
  )
  if (!terminado.affected) {
    logger.log('info', `[CRON] Trial ${sub.id} ya no estaba en trial: no se degrada dos veces`)
    return false
  }

  await deps.subscriptionEventRepo.save(
    deps.subscriptionEventRepo.create({
      subscriptionId: sub.id,
      eventType: SubscriptionEventType.TRIAL_ENDED,
      fromStatus: SubscriptionStatus.TRIAL,
      toStatus: SubscriptionStatus.EXPIRED,
      triggeredBy: 'system',
      reason: `Trial vencido sin método de pago — degradado a ${freePlanSlug()}`,
    }),
  )

  deps.eventBus.publishSubscriptionExpired({
    brandId: sub.brandId,
    subscriptionId: sub.id,
    planSlug: sub.planSlug,
  })
  await deps.eventBus.notifySubscriptionExpired(sub.brandId, sub.planSlug)

  logger.log('info', `[CRON] Trial degradado a ${freePlanSlug()}: brandId=${sub.brandId}`)
  return true
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
