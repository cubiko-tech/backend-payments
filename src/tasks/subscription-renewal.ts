import { In, LessThan } from 'typeorm'

import { freePlanSlug } from '../client/plan-downgrade.util'
import { esSuscripcionRecurrenteDeConfio } from '../provider/confio/confio-recurrencia.util'
import { ProviderFactory } from '../provider/provider.factory'
import { logger } from '../shared/logger/logger'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'
import { endTrialWithoutPayment } from './subscription-expiration'
import { lockAndReread } from './subscription-lock'
import {
  handleRenewalFailure,
  renewFromWallet,
  SubscriptionRenewalDeps as WalletRenewalDeps,
} from './wallet-renewal'

export interface SubscriptionRenewalDeps extends WalletRenewalDeps {
  providerFactory: ProviderFactory
}

/**
 * Converts expired trials: charges the internal wallet if funded, downgrades wallet trials without
 * a wallet to `free`, or issues an external payment link when signup has not already issued one.
 */
export async function processTrialConversions(deps: SubscriptionRenewalDeps): Promise<void> {
  const now = new Date()
  const trials = await deps.subscriptionRepo.find({
    where: {
      status: SubscriptionStatus.TRIAL,
      nextBillingDate: LessThan(now),
      autoRenew: true,
    },
  })

  if (trials.length === 0) return
  logger.log('info', `[CRON] processTrialConversions: ${trials.length} trials vencidos`)

  let converted = 0
  let downgraded = 0
  let linked = 0
  let skipped = 0
  for (const sub of trials) {
    const release = await lockAndReread(sub, deps)
    if (!release) continue
    try {
      if (sub.status !== SubscriptionStatus.TRIAL || !sub.autoRenew) continue

      if (sub.provider === 'wallet') {
        if (!sub.walletId) {
          if (await endTrialWithoutPayment(sub, deps)) downgraded++
          continue
        }
        try {
          if (await renewFromWallet(sub, deps)) {
            converted++
          }
        } catch (error) {
          logger.log('error', `[CRON] Error cobrando trial wallet ${sub.id}: ${error.message}`)
          await handleRenewalFailure(sub, deps, error.message)
        }
        continue
      }

      // Signup issued this row's only initial link: another would open a second charge rail.
      if (sub.initialPaymentLinkIssuedAt) {
        skipped++
        continue
      }

      await issueExternalCharge(sub, false, deps)
      linked++
    } finally {
      await release()
    }
  }

  logger.log(
    'info',
    `[CRON] processTrialConversions: ${converted} cobrados, ${linked} con link emitido, ` +
      `${downgraded} degradados a ${freePlanSlug()}, ` +
      `${skipped} salteados: link inicial ya emitido`,
  )
}

/**
 * Renews due `active` and `past_due` subscriptions that still have retries available.
 */
export async function processSubscriptionRenewals(deps: SubscriptionRenewalDeps): Promise<void> {
  const now = new Date()
  logger.log('info', '[CRON] processSubscriptionRenewals: iniciando')

  const dueSubscriptions = await deps.subscriptionRepo.find({
    where: {
      status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE]),
      autoRenew: true,
      nextBillingDate: LessThan(now),
      retryCount: LessThan(deps.MAX_RETRY),
    },
  })

  let processed = 0
  let withoutWallet = 0
  for (const sub of dueSubscriptions) {
    if (!hasAvailableRetries(sub, deps)) continue
    const release = await lockAndReread(sub, deps)
    if (!release) continue
    try {
      if (!isEligibleForRenewal(sub, now, deps)) {
        continue
      }

      if (sub.provider === 'wallet') {
        if (!sub.walletId) {
          logMissingWallet(sub)
          withoutWallet++
        } else if (await renewFromWallet(sub, deps)) {
          processed++
        }
      } else if (esSuscripcionRecurrenteDeConfio(sub)) {
        await deps.confioWebhook.confirmarContraElProveedor(sub)
        processed++
      } else if (sub.provider === 'confio' && sub.status === SubscriptionStatus.ACTIVE) {
        await issueExternalCharge(sub, false, deps)
        processed++
      }
    } catch (error) {
      logger.log('error', `[CRON] Error renovando suscripción ${sub.id}: ${error.message}`)
      await handleRenewalFailure(sub, deps, error.message)
    } finally {
      await release()
    }
  }

  if (processed > 0 || dueSubscriptions.length > 0) {
    logger.log(
      'info',
      `[CRON] processSubscriptionRenewals: ${processed}/${dueSubscriptions.length} procesadas`,
    )
  }
  if (withoutWallet > 0) {
    logger.log(
      'error',
      `[CRON] processSubscriptionRenewals: ${withoutWallet} wallet subscriptions without walletId`,
    )
  }
}

/**
 * Retries `past_due` subscriptions after their exponential backoff window (24h, 48h, 72h).
 */
export async function retryFailedPayments(deps: SubscriptionRenewalDeps): Promise<void> {
  logger.log('info', '[CRON] retryFailedPayments: iniciando')

  const retryableSubscriptions = await deps.subscriptionRepo.find({
    where: {
      status: SubscriptionStatus.PAST_DUE,
      autoRenew: true,
    },
  })

  let retried = 0
  let withoutWallet = 0
  for (const sub of retryableSubscriptions) {
    if (!isDueForRetry(sub, deps)) continue

    const release = await lockAndReread(sub, deps)
    if (!release) continue
    try {
      if (!isDueForRetry(sub, deps)) continue

      if (sub.provider === 'wallet') {
        if (!sub.walletId) {
          logMissingWallet(sub)
          withoutWallet++
        } else if (await renewFromWallet(sub, deps)) {
          retried++
        }
      } else if (sub.provider === 'confio') {
        await issueExternalCharge(sub, true, deps)
        retried++
      }
    } catch (error) {
      logger.log('error', `[CRON] Reintento fallido para suscripción ${sub.id}: ${error.message}`)
      await handleRenewalFailure(sub, deps, error.message)
    } finally {
      await release()
    }
  }

  if (retried > 0) {
    logger.log('info', `[CRON] retryFailedPayments: ${retried} reintentados`)
  }
  if (withoutWallet > 0) {
    logger.log(
      'error',
      `[CRON] retryFailedPayments: ${withoutWallet} wallet subscriptions without walletId`,
    )
  }
}

/**
 * Sends a daily batch of COP subscription charges for due Dropi subscriptions.
 */
export async function processDropiBatchCharges(deps: SubscriptionRenewalDeps): Promise<void> {
  logger.log('info', '[CRON] processDropiBatchCharges: iniciando')

  const dropiSubscriptions = await deps.subscriptionRepo.find({
    where: {
      status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE]),
      provider: SubscriptionProvider.DROPI,
      autoRenew: true,
      nextBillingDate: LessThan(new Date()),
    },
  })

  if (dropiSubscriptions.length === 0) return

  try {
    const dropiProvider = deps.providerFactory.getDropiProvider()
    const allPrices = await deps.clientRoles.getAllPlanPrices()

    const charges = dropiSubscriptions
      .map((sub) => ({
        userId: sub.userId,
        brandId: sub.brandId,
        amount: allPrices.get(sub.planSlug)?.get('COP') || 0,
        currency: 'COP',
        description: `Suscripción plan ${sub.planSlug}`,
        referenceId: sub.id,
      }))
      .filter((c) => c.amount > 0)

    if (charges.length > 0) {
      await dropiProvider.batchCharge(charges)
      logger.log(
        'info',
        `[CRON] processDropiBatchCharges: ${charges.length} cobros enviados a Dropi`,
      )
    }
  } catch (error) {
    logger.log(
      'error',
      `[CRON] processDropiBatchCharges: error enviando cobros a Dropi: ${error.message}`,
    )
  }
}

async function issueExternalCharge(
  sub: Subscription,
  isRetry: boolean,
  deps: SubscriptionRenewalDeps,
): Promise<void> {
  try {
    const result = await deps.checkoutService.processCheckout({
      brandId: sub.brandId,
      userId: sub.userId,
      purpose: 'plan_purchase',
      provider: sub.provider,
      planSlug: sub.planSlug,
      renewal: true,
    })

    const previousStatus = sub.status
    sub.status = SubscriptionStatus.PAST_DUE
    if (isRetry) sub.retryCount = (sub.retryCount || 0) + 1
    await deps.subscriptionRepo.save(sub)

    await deps.subscriptionEventRepo.save(
      deps.subscriptionEventRepo.create({
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.PAYMENT_FAILED,
        fromStatus: previousStatus,
        toStatus: SubscriptionStatus.PAST_DUE,
        triggeredBy: 'system',
        paymentId: result.paymentId,
        reason: isRetry
          ? `Reintento de cobro ${sub.provider} (${sub.retryCount}/${deps.MAX_RETRY})`
          : `Link de cobro ${sub.provider} emitido`,
      }),
    )

    await deps.eventBus.publishNotification({
      brandId: sub.brandId,
      userId: sub.userId,
      type: 'payment_link',
      subject: `Completa el pago de tu plan ${sub.planSlug}`,
      metadata: {
        checkoutUrl: result.checkoutUrl || '',
        planSlug: sub.planSlug,
        paymentId: result.paymentId,
      },
    })

    logger.log(
      'info',
      `[CRON] Link de cobro ${sub.provider} emitido para brand ${sub.brandId}: ${result.checkoutUrl}`,
    )
  } catch (error) {
    logger.log('error', `[CRON] Error emitiendo cobro externo ${sub.id}: ${error.message}`)
    sub.status = SubscriptionStatus.PAST_DUE
    if (isRetry) sub.retryCount = (sub.retryCount || 0) + 1
    await deps.subscriptionRepo.save(sub)
  }
}

function logMissingWallet(sub: Subscription): void {
  logger.log('error', `[CRON] Subscription ${sub.id} has provider wallet and no walletId`)
}

function hasAvailableRetries(sub: Subscription, deps: SubscriptionRenewalDeps): boolean {
  return (sub.retryCount ?? 0) < deps.MAX_RETRY
}

function isEligibleForRenewal(
  sub: Subscription,
  now: Date,
  deps: SubscriptionRenewalDeps,
): boolean {
  if (![SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE].includes(sub.status)) return false
  if (!sub.autoRenew || !hasAvailableRetries(sub, deps)) return false
  return !(sub.nextBillingDate && new Date(sub.nextBillingDate) >= now)
}

function isDueForRetry(sub: Subscription, deps: SubscriptionRenewalDeps): boolean {
  if (sub.status !== SubscriptionStatus.PAST_DUE || !sub.autoRenew) return false
  if (sub.retryCount >= deps.MAX_RETRY) return false
  const hoursToWait = (sub.retryCount + 1) * 24
  const lastAttempt = sub.updatedAt || sub.createdAt
  return new Date() >= new Date(lastAttempt.getTime() + hoursToWait * 60 * 60 * 1000)
}
