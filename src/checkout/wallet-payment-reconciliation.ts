/**
 * R6: Keeps the wallet payment reconciliation state machine (advisory lock,
 * debit and refund idempotency checks, superseded-plan refund, and subscription
 * completion) in a single cohesive module so every branch runs under one lock contract.
 */
import { DataSource, QueryRunner, Repository } from 'typeorm'

import { AuditService } from '../audit/audit.service'
import { EventBusService } from '../event-bus/event-bus.service'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payment/entities/payment.entity'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../transaction/entities/transaction.entity'
import { WalletService } from '../wallet/wallet.service'
import { lockPayment } from '../payment/payment-lock'
import type { CheckoutRequest, CheckoutResult } from './checkout.service'
import type { WalletCloseResult } from './wallet-payment-close'

/**
 * Minimum age before a wallet payment is eligible for background reconciliation.
 * Matches the 2-minute cutoff used by external payment reconciliation so an
 * in-flight checkout on any instance has time to commit its debit and post-debit
 * effects before the sweep inspects the row.
 */
export const WALLET_RECONCILE_MIN_AGE_MS = 2 * 60 * 1000

/** How far back the sweep looks for `failed` payments with a debit to credit back. */
export const WALLET_FAILED_DEBIT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000

/** Age from which a close that still fails is given up: the sweep credits the debit back. */
export const WALLET_CLOSE_GIVE_UP_MS = 60 * 60 * 1000

export interface WalletPaymentReconciliationDeps {
  paymentRepo: Repository<Payment>
  subscriptionRepo?: Repository<Subscription>
  subscriptionEventRepo?: Pick<Repository<SubscriptionEvent>, 'findOne'>
  walletService?: Pick<WalletService, 'findDebitByIdempotencyKey' | 'credit'>
  transactionReadRepo?: Repository<Transaction>
  dataSource?: DataSource
  inProcessLocks?: Map<string, Promise<void>>
  logger?: { error: (message: string) => void }
  closeWalletPayment: (payment: Payment, req: CheckoutRequest) => Promise<WalletCloseResult>
  assignPlanInRoles: (brandId: string, planSlug: string, expiresAt?: Date) => Promise<void>
  auditService: Pick<AuditService, 'log'>
  eventBus: Pick<EventBusService, 'publishPaymentCompleted' | 'notifyPaymentSuccess'>
}

export interface WalletPaymentReconciliationResult {
  outcome: 'completed' | 'failed_without_debit' | 'refunded' | 'noop'
  status: string
  subscriptionId?: string
}

export function getWalletDebitIdempotencyKey(paymentId: string): string {
  return `payment:${paymentId}:debit`
}

export function getWalletRefundIdempotencyKey(paymentId: string): string {
  return `payment:${paymentId}:refund`
}

export function isWalletPaymentOldEnoughForReconcile(
  payment: Pick<Payment, 'createdAt'>,
  now: Date = new Date(),
): boolean {
  if (!payment.createdAt) {
    return true
  }
  const createdTime = new Date(payment.createdAt).getTime()
  if (!Number.isFinite(createdTime)) {
    return true
  }
  return createdTime <= now.getTime() - WALLET_RECONCILE_MIN_AGE_MS
}

export async function acquireWalletReconcileLock(
  paymentId: string,
  dataSource?: DataSource,
  inProcessLocks?: Map<string, Promise<void>>,
): Promise<() => Promise<void>> {
  const previous = inProcessLocks?.get(paymentId) ?? Promise.resolve()
  let releaseInProcess!: () => void
  const current = new Promise<void>((resolve) => {
    releaseInProcess = resolve
  })
  const tail = previous.then(() => current)
  inProcessLocks?.set(paymentId, tail)

  let queryRunner: QueryRunner | null = null
  let released = false

  const release = async (commit = true) => {
    if (released) {
      return
    }
    released = true
    try {
      if (queryRunner) {
        try {
          if (queryRunner.isTransactionActive) {
            if (commit) {
              await queryRunner.commitTransaction()
            } else {
              await queryRunner.rollbackTransaction()
            }
          }
        } finally {
          if (!queryRunner.isReleased) {
            await queryRunner.release()
          }
        }
      }
    } finally {
      releaseInProcess()
      if (inProcessLocks?.get(paymentId) === tail) {
        inProcessLocks.delete(paymentId)
      }
    }
  }

  try {
    await previous
    if (typeof (dataSource as any)?.createQueryRunner === 'function') {
      const candidate = dataSource!.createQueryRunner()
      if (typeof candidate?.query === 'function') {
        queryRunner = candidate
        await queryRunner.connect()
        await queryRunner.startTransaction()
        await lockPayment(queryRunner, paymentId)
      }
    }
    return () => release(true)
  } catch (error) {
    await release(false).catch(() => undefined)
    throw error
  }
}

export async function hasWalletPaymentDebit(
  payment: Pick<Payment, 'id' | 'walletId'>,
  deps: Pick<
    WalletPaymentReconciliationDeps,
    'walletService' | 'transactionReadRepo' | 'dataSource'
  >,
): Promise<boolean> {
  const idempotencyKey = getWalletDebitIdempotencyKey(payment.id)

  if (payment.walletId && typeof deps.walletService?.findDebitByIdempotencyKey === 'function') {
    const existing = await deps.walletService.findDebitByIdempotencyKey(
      payment.walletId,
      idempotencyKey,
    )
    if (existing) {
      return true
    }
  }

  if (typeof deps.transactionReadRepo?.findOne === 'function') {
    const fromReadRepo = await deps.transactionReadRepo.findOne({
      where: { idempotencyKey },
    })
    if (fromReadRepo && fromReadRepo.idempotencyKey === idempotencyKey) {
      return true
    }
  }

  if (typeof (deps.dataSource as any)?.getRepository === 'function') {
    const txRepo = deps.dataSource!.getRepository(Transaction)
    if (typeof txRepo?.findOne === 'function') {
      const byKey = await txRepo.findOne({
        where: { idempotencyKey },
      })
      if (byKey && byKey.idempotencyKey === idempotencyKey) {
        return true
      }

      const byReference = await txRepo.findOne({
        where: {
          referenceType: 'payment',
          referenceId: payment.id,
          type: TransactionType.DEBIT,
          status: TransactionStatus.COMPLETED,
        },
      })
      if (byReference && byReference.referenceId === payment.id) {
        return true
      }
    }
  }

  return false
}

export async function hasWalletPaymentRefund(
  payment: Pick<Payment, 'id' | 'walletId'>,
  deps: Pick<
    WalletPaymentReconciliationDeps,
    'walletService' | 'transactionReadRepo' | 'dataSource'
  >,
): Promise<boolean> {
  const idempotencyKey = getWalletRefundIdempotencyKey(payment.id)

  if (payment.walletId && typeof deps.walletService?.findDebitByIdempotencyKey === 'function') {
    const existing = await deps.walletService.findDebitByIdempotencyKey(
      payment.walletId,
      idempotencyKey,
    )
    if (existing) {
      return true
    }
  }

  if (typeof deps.transactionReadRepo?.findOne === 'function') {
    const fromReadRepo = await deps.transactionReadRepo.findOne({
      where: { idempotencyKey },
    })
    if (fromReadRepo && fromReadRepo.idempotencyKey === idempotencyKey) {
      return true
    }
  }

  if (typeof (deps.dataSource as any)?.getRepository === 'function') {
    const txRepo = deps.dataSource!.getRepository(Transaction)
    if (typeof txRepo?.findOne === 'function') {
      const byKey = await txRepo.findOne({
        where: { idempotencyKey },
      })
      if (byKey && byKey.idempotencyKey === idempotencyKey) {
        return true
      }

      const byReference = await txRepo.findOne({
        where: {
          referenceType: 'payment',
          referenceId: payment.id,
          type: TransactionType.CREDIT,
          status: TransactionStatus.COMPLETED,
        },
      })
      if (byReference && byReference.referenceId === payment.id) {
        return true
      }
    }
  }

  return false
}

/** Whether the payment `lastPaymentId` names was created after `payment`. */
export async function isLastPaymentNewer(
  lastPaymentId: string,
  payment: Payment,
  paymentRepo: Pick<Repository<Payment>, 'findOne'>,
): Promise<boolean> {
  const lastPayment = await paymentRepo.findOne({ where: { id: lastPaymentId } })
  if (!lastPayment) {
    return false
  }
  const lastTime = new Date(lastPayment.createdAt).getTime()
  const paymentTime = new Date(payment.createdAt).getTime()
  if (!Number.isFinite(lastTime) || !Number.isFinite(paymentTime)) {
    return false
  }
  return lastTime > paymentTime
}

export async function findConflictingPlanSubscription(
  payment: Payment,
  deps: Pick<WalletPaymentReconciliationDeps, 'subscriptionRepo' | 'paymentRepo' | 'dataSource'>,
): Promise<Subscription | null> {
  const subRepo =
    deps.subscriptionRepo ??
    (typeof (deps.dataSource as any)?.getRepository === 'function'
      ? deps.dataSource!.getRepository(Subscription)
      : undefined)
  if (typeof subRepo?.findOne !== 'function' || typeof deps.paymentRepo?.findOne !== 'function') {
    return null
  }
  const existingSub = await subRepo.findOne({ where: { brandId: payment.brandId } })
  if (
    !existingSub ||
    !existingSub.planSlug ||
    existingSub.planSlug === payment.purposeId ||
    !existingSub.lastPaymentId ||
    existingSub.lastPaymentId === payment.id
  ) {
    return null
  }
  const newer = await isLastPaymentNewer(existingSub.lastPaymentId, payment, deps.paymentRepo)
  return newer ? existingSub : null
}

/** Whether the payment already took effect on the subscription of its brand. */
async function isPlanAppliedByPayment(
  payment: Payment,
  deps: Pick<WalletPaymentReconciliationDeps, 'subscriptionRepo' | 'subscriptionEventRepo'>,
): Promise<boolean> {
  const sub = await deps.subscriptionRepo?.findOne({ where: { brandId: payment.brandId } })
  if (sub?.lastPaymentId === payment.id) {
    return true
  }
  const event = await deps.subscriptionEventRepo?.findOne({ where: { paymentId: payment.id } })
  return !!event
}

async function refundSupersededWalletPayment(
  payment: Payment,
  conflictingSub: Subscription | null,
  totalAmount: number,
  deps: WalletPaymentReconciliationDeps,
  refundRecorded = false,
  closeFailure?: string,
): Promise<WalletPaymentReconciliationResult> {
  const refundKey = getWalletRefundIdempotencyKey(payment.id)
  const fromStatus = payment.status
  const cause =
    closeFailure ??
    (fromStatus === PaymentStatus.FAILED
      ? 'its checkout failed after the debit'
      : `subscription is on newer plan ${conflictingSub?.planSlug ?? payment.purposeId}`)
  if (!refundRecorded) {
    if (!payment.walletId || typeof deps.walletService?.credit !== 'function') {
      deps.logger?.error(
        `reconcileWalletPayment: cannot refund superseded payment ${payment.id} (${payment.purposeId}) because wallet credit is unavailable`,
      )
      return { outcome: 'noop', status: fromStatus }
    }

    try {
      const creditResult = await deps.walletService.credit(payment.walletId, totalAmount, {
        brandId: payment.brandId,
        category: 'refund',
        description: `Refund for payment ${payment.id} (${payment.purposeId}): ${cause}`,
        referenceType: 'payment',
        referenceId: payment.id,
        idempotencyKey: refundKey,
      })
      if (!creditResult || (creditResult as any).error) {
        throw new Error((creditResult as any)?.error ?? 'unknown credit error')
      }
    } catch (error: any) {
      deps.logger?.error(
        `reconcileWalletPayment: failed to credit wallet ${payment.walletId} for superseded payment ${payment.id}: ${error?.message ?? error}`,
      )
      return { outcome: 'noop', status: fromStatus }
    }
  }

  const conflictingPlanSlug = conflictingSub?.planSlug ?? null
  await deps.auditService.log(
    payment.userId || 'system',
    'wallet_payment_refunded',
    'payment',
    payment.id,
    {
      purpose: payment.purpose,
      planSlug: payment.purposeId,
      conflictingPlanSlug,
      conflictingPaymentId: conflictingSub?.lastPaymentId ?? null,
      amount: totalAmount,
      walletId: payment.walletId,
      idempotencyKey: refundKey,
      provider: 'wallet',
      reconciled: true,
    },
    `Wallet payment refunded via reconciliation because ${cause}: ${payment.currency} ${totalAmount}`,
  )

  const refunded = await deps.paymentRepo.update(
    { id: payment.id, status: fromStatus },
    { status: PaymentStatus.REFUNDED },
  )
  if (!refunded.affected) {
    const latest = await deps.paymentRepo.findOne({ where: { id: payment.id } })
    return { outcome: 'noop', status: latest?.status ?? fromStatus }
  }
  return { outcome: 'refunded', status: PaymentStatus.REFUNDED }
}

/**
 * Whether a payment whose close just failed gets credited instead of swept again: only past
 * the give-up age, still `processing` (a failed commit may have closed it) and with no plan
 * applied (a purchase handed back to the sweep keeps its period).
 */
async function shouldGiveUpOnClose(
  payment: Payment,
  now: Date,
  deps: WalletPaymentReconciliationDeps,
): Promise<boolean> {
  if (new Date(payment.createdAt).getTime() > now.getTime() - WALLET_CLOSE_GIVE_UP_MS) {
    return false
  }
  const latest = await deps.paymentRepo.findOne({ where: { id: payment.id } })
  if (latest?.status !== PaymentStatus.PROCESSING) {
    return false
  }
  if (await isPlanAppliedByPayment(payment, deps)) {
    deps.logger?.error(
      `reconcileWalletPayment: payment ${payment.id} keeps failing to close with its plan applied; not crediting it`,
    )
    return false
  }
  return true
}

async function completeReconciledWalletPayment(
  payment: Payment,
  totalAmount: number,
  deps: WalletPaymentReconciliationDeps,
  now: Date,
): Promise<WalletPaymentReconciliationResult> {
  const result: CheckoutResult = {
    paymentId: payment.id,
    status: 'completed',
  }

  const req: CheckoutRequest = {
    brandId: payment.brandId,
    userId: payment.userId,
    provider: 'wallet',
    purpose: (payment.purpose as any) || PaymentPurpose.PLAN_PURCHASE,
    planSlug: payment.purposeId || undefined,
    walletId: payment.walletId || undefined,
    idempotencyKey: payment.idempotencyKey || undefined,
  }

  let closed: WalletCloseResult
  try {
    closed = await deps.closeWalletPayment(payment, req)
  } catch (error: any) {
    if (!(await shouldGiveUpOnClose(payment, now, deps))) {
      throw error
    }
    const closeFailure = `its close kept failing: ${error?.message ?? error}`
    return refundSupersededWalletPayment(payment, null, totalAmount, deps, false, closeFailure)
  }
  if (closed.outcome === 'superseded') {
    return refundSupersededWalletPayment(payment, null, totalAmount, deps)
  }
  if (closed.outcome === 'already_closed') {
    return { outcome: 'noop', status: closed.payment?.status ?? PaymentStatus.PROCESSING }
  }

  const sub = closed.subscription
  if (sub) {
    result.subscriptionId = sub.id
    if (closed.extended && sub.currentPeriodEnd) {
      result.renewal = 'extended'
      result.currentPeriodEnd = sub.currentPeriodEnd
    }
    // Outside the brand lock: backend-roles is HTTP. Sends the plan that ended up current.
    const current = await deps.subscriptionRepo?.findOne({ where: { brandId: payment.brandId } })
    await deps.assignPlanInRoles(
      payment.brandId,
      current?.planSlug ?? sub.planSlug,
      current?.currentPeriodEnd ?? sub.currentPeriodEnd,
    )
  }

  await deps.auditService.log(
    payment.userId || 'system',
    'checkout_completed',
    'payment',
    payment.id,
    {
      purpose: payment.purpose,
      planSlug: payment.purposeId,
      amount: totalAmount,
      provider: 'wallet',
      reconciled: true,
    },
    `Wallet checkout completed via reconciliation: ${payment.purpose} for ${payment.currency} ${totalAmount}`,
  )

  if (payment.idempotencyKey) {
    await deps.paymentRepo.update(
      { id: payment.id, status: PaymentStatus.COMPLETED },
      { metadata: { ...(payment.metadata || {}), checkoutResult: result } },
    )
  }

  deps.eventBus.publishPaymentCompleted({
    brandId: payment.brandId,
    paymentId: payment.id,
    amount: String(payment.amount),
    currency: payment.currency,
    purpose: payment.purpose,
    planSlug: payment.purposeId || undefined,
  })

  deps.eventBus.notifyPaymentSuccess(
    payment.brandId,
    payment.id,
    String(payment.amount),
    payment.currency,
  )

  return {
    outcome: 'completed',
    status: PaymentStatus.COMPLETED,
    subscriptionId: result.subscriptionId,
  }
}

export async function reconcileWalletPayment(
  paymentId: string,
  deps: WalletPaymentReconciliationDeps,
  now: Date = new Date(),
): Promise<WalletPaymentReconciliationResult> {
  const releaseLock = await acquireWalletReconcileLock(
    paymentId,
    deps.dataSource,
    deps.inProcessLocks,
  )
  try {
    const payment = await deps.paymentRepo.findOne({ where: { id: paymentId } })
    if (!payment || payment.provider !== PaymentProvider.WALLET) {
      return { outcome: 'noop', status: payment?.status ?? 'not_found' }
    }

    if (
      payment.status !== PaymentStatus.PENDING &&
      payment.status !== PaymentStatus.PROCESSING &&
      payment.status !== PaymentStatus.FAILED
    ) {
      return { outcome: 'noop', status: payment.status }
    }

    if (!isWalletPaymentOldEnoughForReconcile(payment, now)) {
      return { outcome: 'noop', status: payment.status }
    }

    const debited = await hasWalletPaymentDebit(payment, deps)

    if (!debited) {
      if (payment.status !== PaymentStatus.PENDING) {
        return { outcome: 'noop', status: payment.status }
      }

      const claimed = await deps.paymentRepo.update(
        { id: payment.id, status: PaymentStatus.PENDING },
        {
          status: PaymentStatus.FAILED,
          failureReason: 'Wallet debit was not recorded before checkout interrupted',
        },
      )
      if (!claimed.affected) {
        const latest = await deps.paymentRepo.findOne({ where: { id: paymentId } })
        return { outcome: 'noop', status: latest?.status ?? payment.status }
      }
      return { outcome: 'failed_without_debit', status: PaymentStatus.FAILED }
    }

    const totalAmount = Math.round(parseFloat(String(payment.amount || 0)) * 100) / 100

    // The buyer was already told it failed, so a debit found here is only ever credited back.
    if (payment.status === PaymentStatus.FAILED) {
      if (await isPlanAppliedByPayment(payment, deps)) {
        deps.logger?.error(
          `reconcileWalletPayment: failed payment ${payment.id} has a debit and its plan applied; not crediting it`,
        )
        return { outcome: 'noop', status: payment.status }
      }
      const refundRecorded = await hasWalletPaymentRefund(payment, deps)
      return await refundSupersededWalletPayment(payment, null, totalAmount, deps, refundRecorded)
    }

    if (payment.status === PaymentStatus.PENDING) {
      const claimed = await deps.paymentRepo.update(
        { id: payment.id, status: PaymentStatus.PENDING },
        { status: PaymentStatus.PROCESSING },
      )
      if (!claimed.affected) {
        const latest = await deps.paymentRepo.findOne({ where: { id: paymentId } })
        return { outcome: 'noop', status: latest?.status ?? payment.status }
      }
      payment.status = PaymentStatus.PROCESSING
    }

    const conflictingSub =
      payment.purpose === PaymentPurpose.PLAN_PURCHASE && payment.purposeId
        ? await findConflictingPlanSubscription(payment, deps)
        : null
    const refundRecorded = conflictingSub ? false : await hasWalletPaymentRefund(payment, deps)
    if (conflictingSub || refundRecorded) {
      return await refundSupersededWalletPayment(
        payment,
        conflictingSub,
        totalAmount,
        deps,
        refundRecorded,
      )
    }

    return await completeReconciledWalletPayment(payment, totalAmount, deps, now)
  } finally {
    await releaseLock()
  }
}
