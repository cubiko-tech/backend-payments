import { DataSource, FindOptionsWhere, Raw, Repository } from 'typeorm'

import { AuditService } from '../audit/audit.service'
import { logger } from '../shared/logger/logger'
import {
  LIVE_SUBSCRIPTION_STATUSES,
  Subscription,
} from '../subscription/entities/subscription.entity'
import { Transaction, TransactionType } from '../transaction/entities/transaction.entity'
import { WalletService } from '../wallet/wallet.service'
import { lockAndReread, SubscriptionLockDeps } from './subscription-lock'

/**
 * `metadata.cycleExtension` of a renewal debit. Written with the debit as `pending`: a renewal that
 * extends also moves `nextBillingDate`, so the date alone cannot tell it from an orphan.
 */
export const CycleExtension = {
  PENDING: 'pending',
  EXTENDED: 'extended',
  REFUNDED: 'refunded',
} as const

export function markCycleDebit(
  transactionRepo: Pick<Repository<Transaction>, 'update'>,
  where: FindOptionsWhere<Transaction>,
  mark: (typeof CycleExtension)[keyof typeof CycleExtension],
) {
  const metadata: Transaction['metadata'] = { cycleExtension: mark }
  return transactionRepo.update(where, { metadata })
}

/** Idempotency key of the renewal debit of the cycle the row is on. */
export function cycleDebitKey(sub: Pick<Subscription, 'id' | 'nextBillingDate'>): string {
  const cycle =
    sub.nextBillingDate instanceof Date
      ? sub.nextBillingDate.toISOString()
      : String(sub.nextBillingDate)
  return `subscription:${sub.id}:${cycle}`
}

/** Renewal debits that no pass has extended or refunded yet. */
export const PENDING_CYCLE_DEBITS: FindOptionsWhere<Transaction> = {
  type: TransactionType.DEBIT,
  referenceType: 'subscription',
  metadata: Raw((column) => `${column} ->> 'cycleExtension' = '${CycleExtension.PENDING}'`),
}

/**
 * Whether a renewal pass can still extend the cycle this debit paid: the row is live and still on
 * that cycle. `autoRenew` does not decide: `reactivate` revives a pending cancellation with the same
 * date, and a pass would then find this debit and extend for free had it been refunded.
 */
export function canStillExtend(
  debit: Pick<Transaction, 'idempotencyKey'>,
  sub: Pick<Subscription, 'id' | 'nextBillingDate' | 'status'>,
): boolean {
  return (
    LIVE_SUBSCRIPTION_STATUSES.includes(sub.status) &&
    !!sub.nextBillingDate &&
    debit.idempotencyKey === cycleDebitKey(sub)
  )
}

export interface RenewalDebitRefundDeps {
  walletService: Pick<WalletService, 'credit'>
  auditService: Pick<AuditService, 'log'>
  transactionRepo: Pick<Repository<Transaction>, 'update'>
}

/**
 * Credits an orphan renewal debit to the wallet it came from, reopening it if closed, then audits
 * and marks it. Idempotent: a repeated credit hits the unique key and `credit` returns the existing
 * movement. Returns false, with the debit still `pending` for the next sweep, if the credit failed.
 */
export async function refundRenewalDebit(
  debit: Transaction,
  deps: RenewalDebitRefundDeps,
): Promise<boolean> {
  const amount = Number(debit.amount)
  try {
    const result = await deps.walletService.credit(
      debit.walletId,
      amount,
      {
        brandId: debit.brandId,
        category: 'refund',
        description: `Refund of renewal debit ${debit.idempotencyKey}: its cycle was not extended`,
        referenceType: 'subscription',
        referenceId: debit.referenceId,
        idempotencyKey: `${debit.idempotencyKey}:refund`,
      },
      undefined,
      { userId: 'system', reason: `refund of renewal debit ${debit.idempotencyKey}` },
    )
    if (!result || 'error' in result) {
      throw new Error(result?.error ?? 'unknown credit error')
    }
  } catch (error) {
    logger.log(
      'error',
      `[CRON] Could not refund renewal debit ${debit.idempotencyKey}: ${error?.message}`,
    )
    return false
  }

  await deps.auditService.log(
    'system',
    'renewal_debit_refunded',
    'subscription',
    debit.referenceId,
    { walletId: debit.walletId, amount, debitKey: debit.idempotencyKey },
    `Renewal debit refunded to wallet ${debit.walletId}: its cycle was not extended`,
  )
  logger.log(
    'warn',
    `[CRON] Renewal debit refunded: subscription=${debit.referenceId} ` +
      `wallet=${debit.walletId} amount=${amount} key=${debit.idempotencyKey}`,
  )
  await markCycleDebit(deps.transactionRepo, { id: debit.id }, CycleExtension.REFUNDED)
  return true
}

export interface OrphanRenewalSweepDeps extends SubscriptionLockDeps {
  dataSource: DataSource
  walletService: Pick<WalletService, 'credit'>
  auditService: Pick<AuditService, 'log'>
}

/**
 * Credits back the renewal debits no pass can extend any more. Each one is decided under the
 * brand's plan lock, with row and debit reread from the primary, so a pass or a checkout in flight
 * finishes first. A failure on one debit leaves it pending and does not stop the rest.
 */
export async function refundOrphanRenewalDebits(deps: OrphanRenewalSweepDeps): Promise<void> {
  const transactionRepo = deps.dataSource.getRepository(Transaction)
  const pending = await transactionRepo.find({ where: PENDING_CYCLE_DEBITS })

  let refunded = 0
  for (const { id, referenceId } of pending) {
    try {
      const sub = await deps.subscriptionRepo.findOne({ where: { id: referenceId } })
      if (!sub) {
        logger.log('error', `[CRON] Renewal debit ${id}: subscription ${referenceId} not found`)
        continue
      }
      const release = await lockAndReread(sub, deps)
      if (!release) continue
      try {
        const debit = await transactionRepo.findOne({ where: { id } })
        if (debit?.metadata?.cycleExtension !== CycleExtension.PENDING) continue
        if (canStillExtend(debit, sub)) continue
        const done = await refundRenewalDebit(debit, {
          walletService: deps.walletService,
          auditService: deps.auditService,
          transactionRepo,
        })
        if (done) refunded++
      } finally {
        await release()
      }
    } catch (error) {
      logger.log('error', `[CRON] Error refunding renewal debit ${id}: ${error.message}`)
    }
  }

  if (refunded > 0) {
    logger.log('warn', `[CRON] refundOrphanRenewalDebits: ${refunded} refunded`)
  }
}
