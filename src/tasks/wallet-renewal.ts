import { HttpStatus } from '@nestjs/common'
import { And, In, IsNull, LessThan, MoreThanOrEqual, Not, Repository } from 'typeorm'

import { CheckoutService } from '../checkout/checkout.service'
import { RequestException } from '../shared/exception/request.exception'
import { logger } from '../shared/logger/logger'
import {
  LIVE_SUBSCRIPTION_STATUSES,
  Subscription,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { Wallet } from '../wallet/entities/wallet.entity'
import { WalletService } from '../wallet/wallet.service'
import { cycleDebitKey, CycleExtension, markCycleDebit } from './renewal-debit-refund'
import { SubscriptionExpirationDeps } from './subscription-expiration'

/** Rolls back the mark of a renewal debit, so the sweep refunds it, when the row was closed. */
class RowNoLongerLiveError extends Error {}

export interface SubscriptionRenewalDeps extends SubscriptionExpirationDeps {
  walletReadRepo: Repository<Wallet>
  transactionReadRepo: Repository<Transaction>
  walletService: WalletService
  checkoutService: CheckoutService
  BILLING_PERIOD_DAYS: number
  RENEWAL_POSTPONEMENT_GRACE_HOURS: number
}

/**
 * Charges the subscription's internal wallet for the current billing cycle and extends its period.
 * Reuses an existing unrefunded cycle debit on retries so a cycle is never debited twice.
 */
export async function renewFromWallet(
  sub: Subscription,
  deps: SubscriptionRenewalDeps,
): Promise<boolean> {
  if (typeof sub.walletId !== 'string' || !sub.walletId.trim()) {
    throw new RequestException(
      { code: 'MISSING_WALLET_ID', message: 'walletId is required' },
      HttpStatus.BAD_REQUEST,
    )
  }

  if (!sub.nextBillingDate) {
    logger.log('error', `[CRON] Wallet subscription ${sub.id} has no nextBillingDate: not charged`)
    return false
  }

  const idempotencyKey = cycleDebitKey(sub)

  if (await hasCycleDebit(sub.walletId, idempotencyKey, deps)) {
    const debit = await deps.dataSource
      .getRepository(Transaction)
      .findOne({ where: { idempotencyKey } })
    if (debit?.metadata?.cycleExtension === CycleExtension.REFUNDED) {
      logger.log(
        'error',
        `[CRON] Subscription ${sub.id} is live on a cycle already refunded: not extended`,
      )
      return false
    }
  } else {
    const currency = await resolveWalletCurrency(sub.walletId, deps)
    const amount = await deps.clientRoles.getPlanPrice(sub.planSlug, currency)

    if (amount === null || amount === undefined) {
      if (
        typeof deps.clientRoles.hasCachedPrices === 'function' &&
        !deps.clientRoles.hasCachedPrices()
      ) {
        logger.log(
          'error',
          `[CRON] Cannot resolve price for subscription ${sub.id} (brand=${sub.brandId}, plan=${sub.planSlug}): backend-roles unreachable with cold price cache`,
        )
        if (isPostponementGraceExceeded(sub, deps)) {
          throw new Error(
            `Renewal postponement grace period exceeded for subscription ${sub.id}: backend-roles price unavailable for plan '${sub.planSlug}'`,
          )
        }
        return false
      }
      throw new RequestException(
        {
          code: 'WALLET_CURRENCY_MISMATCH',
          message: `Plan '${sub.planSlug}' has no price in wallet currency ${currency}`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    if (amount === 0) {
      return extendSubscriptionPeriod(sub, deps)
    }

    const debitResult = await deps.walletService.debit(
      sub.walletId,
      amount,
      {
        brandId: sub.brandId,
        category: 'plan_payment',
        description: `Renovación plan ${sub.planSlug}`,
        referenceType: 'subscription',
        referenceId: sub.id,
        idempotencyKey,
        metadata: { cycleExtension: CycleExtension.PENDING },
      },
      currency,
    )
    if (
      debitResult &&
      typeof debitResult === 'object' &&
      'error' in debitResult &&
      (debitResult as any).error
    ) {
      throw new Error((debitResult as any).error)
    }
  }

  if (!(await extendSubscriptionPeriod(sub, deps, idempotencyKey))) {
    return false
  }

  try {
    await deps.subscriptionEventRepo.save(
      deps.subscriptionEventRepo.create({
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.RENEWED,
        toPlanSlug: sub.planSlug,
        fromStatus: sub.status,
        toStatus: SubscriptionStatus.ACTIVE,
        triggeredBy: 'system',
        reason: 'Renovación automática desde wallet',
      }),
    )
  } catch (error) {
    logger.log(
      'error',
      `[CRON] Subscription ${sub.id} renewed without its history row: ${error?.message}`,
    )
  }

  deps.eventBus.publishSubscriptionRenewed({
    brandId: sub.brandId,
    subscriptionId: sub.id,
    planSlug: sub.planSlug,
  })

  return true
}

/**
 * Extends `sub` by `BILLING_PERIOD_DAYS` in `backend-roles` and persists the new period and debit
 * mark atomically while the row remains live.
 */
export async function extendSubscriptionPeriod(
  sub: Subscription,
  deps: SubscriptionRenewalDeps,
  debitKey?: string,
): Promise<boolean> {
  const newPeriodStart = new Date()
  const newPeriodEnd = new Date()
  newPeriodEnd.setDate(newPeriodEnd.getDate() + deps.BILLING_PERIOD_DAYS)

  const renewed = await deps.clientRoles.renewPlanForBrand(sub.brandId, sub.planSlug, newPeriodEnd)
  if (!renewed) {
    logger.log(
      'error',
      `[CRON] backend-roles returned false when renewing subscription ${sub.id} (brand=${sub.brandId}, plan=${sub.planSlug})`,
    )
    return false
  }

  const extension = {
    currentPeriodStart: newPeriodStart,
    currentPeriodEnd: newPeriodEnd,
    nextBillingDate: newPeriodEnd,
    status: SubscriptionStatus.ACTIVE,
    retryCount: 0,
  }

  try {
    await deps.dataSource.transaction(async (manager) => {
      if (debitKey) {
        await markCycleDebit(
          manager.getRepository(Transaction),
          { idempotencyKey: debitKey },
          CycleExtension.EXTENDED,
        )
      }
      const subscriptions = manager.getRepository(Subscription)
      const written = await subscriptions.update(
        { id: sub.id, status: In(LIVE_SUBSCRIPTION_STATUSES) },
        extension,
      )
      if (!written.affected) throw new RowNoLongerLiveError()
      await subscriptions.update(
        { id: sub.id, accessEndsAt: Not(IsNull()) },
        { accessEndsAt: newPeriodEnd },
      )
    })
  } catch (error) {
    if (!(error instanceof RowNoLongerLiveError)) throw error
    logger.log('error', `[CRON] Subscription ${sub.id} closed during its renewal: not extended`)
    return false
  }
  Object.assign(sub, extension)
  return true
}

/**
 * Records a failed renewal attempt: increments `retryCount`, sets `past_due` via compare-and-set
 * on the current billing cycle, writes the failure event, and sends the dunning notice.
 */
export async function handleRenewalFailure(
  sub: Subscription,
  deps: SubscriptionRenewalDeps,
  failureReason?: string,
): Promise<void> {
  const previousStatus = sub.status
  sub.retryCount = (sub.retryCount || 0) + 1
  sub.status = SubscriptionStatus.PAST_DUE
  const cycleStart = new Date(sub.nextBillingDate).getTime()
  const written = await deps.subscriptionRepo.update(
    {
      id: sub.id,
      status: In(LIVE_SUBSCRIPTION_STATUSES),
      nextBillingDate: sub.nextBillingDate
        ? And(MoreThanOrEqual(new Date(cycleStart)), LessThan(new Date(cycleStart + 1)))
        : IsNull(),
    },
    { retryCount: sub.retryCount, status: sub.status },
  )
  if (!written.affected) {
    logger.log(
      'error',
      `[CRON] Subscription ${sub.id} closed or moved during its renewal: no failure kept`,
    )
    return
  }

  const baseReason = `Intento de pago fallido (${sub.retryCount}/${deps.MAX_RETRY})`
  await deps.subscriptionEventRepo.save(
    deps.subscriptionEventRepo.create({
      subscriptionId: sub.id,
      eventType: SubscriptionEventType.PAYMENT_FAILED,
      fromStatus: previousStatus,
      toStatus: SubscriptionStatus.PAST_DUE,
      triggeredBy: 'system',
      reason: failureReason ? `${baseReason}: ${failureReason}` : baseReason,
    }),
  )

  const dunningMessages: Record<number, string> = {
    1: 'Tu pago falló. Verifica tu método de pago.',
    2: 'Segundo intento de pago fallido. Actualiza tu método de pago para no perder tu plan.',
    3: 'Último intento de pago. Si no se resuelve, tu plan será desactivado.',
  }
  const message = dunningMessages[sub.retryCount] || 'Tu pago no pudo ser procesado.'
  await deps.eventBus.notifyPaymentFailed(sub.brandId, sub.id, message)
  logger.log(
    'info',
    `[DUNNING] Notificación enviada a marca ${sub.brandId}: intento ${sub.retryCount}/${deps.MAX_RETRY}`,
  )
}

async function hasCycleDebit(
  walletId: string,
  idempotencyKey: string,
  deps: SubscriptionRenewalDeps,
): Promise<boolean> {
  if (typeof deps.walletService?.findDebitByIdempotencyKey === 'function') {
    const existing = await deps.walletService.findDebitByIdempotencyKey(walletId, idempotencyKey)
    if (existing) return true
  }
  const existingFromReadRepo = await deps.transactionReadRepo?.findOne({
    where: { idempotencyKey },
  })
  return Boolean(existingFromReadRepo && existingFromReadRepo.idempotencyKey === idempotencyKey)
}

async function resolveWalletCurrency(
  walletId: string,
  deps: SubscriptionRenewalDeps,
): Promise<string> {
  const readWallet = await deps.walletReadRepo?.findOne({ where: { id: walletId } })
  if (readWallet?.currency) return readWallet.currency
  if (typeof deps.walletService?.findById === 'function') {
    try {
      const found = await deps.walletService.findById(walletId)
      if (found && 'data' in found && found.data?.currency) return found.data.currency
    } catch {
      return 'COP'
    }
  }
  return 'COP'
}

function isPostponementGraceExceeded(
  sub: Subscription,
  deps: SubscriptionRenewalDeps,
  now = new Date(),
): boolean {
  if (!sub.nextBillingDate) return false
  const billingTime = new Date(sub.nextBillingDate).getTime()
  if (!Number.isFinite(billingTime)) return false
  return now.getTime() - billingTime >= deps.RENEWAL_POSTPONEMENT_GRACE_HOURS * 60 * 60 * 1000
}
