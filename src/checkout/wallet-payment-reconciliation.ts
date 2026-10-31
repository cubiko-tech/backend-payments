import { DataSource, QueryRunner, Repository } from 'typeorm'

import { AuditService } from '../audit/audit.service'
import { EventBusService } from '../event-bus/event-bus.service'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payment/entities/payment.entity'
import { Subscription, SubscriptionStatus } from '../subscription/entities/subscription.entity'
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../transaction/entities/transaction.entity'
import { WalletService } from '../wallet/wallet.service'
import type { CheckoutRequest, CheckoutResult } from './checkout.service'

/**
 * Minimum age before a wallet payment is eligible for background reconciliation.
 * Matches the 2-minute cutoff used by external payment reconciliation so an
 * in-flight checkout on any instance has time to commit its debit and post-debit
 * effects before the sweep inspects the row.
 */
export const WALLET_RECONCILE_MIN_AGE_MS = 2 * 60 * 1000

export interface WalletPaymentReconciliationDeps {
  paymentRepo: Repository<Payment>
  subscriptionRepo?: Repository<Subscription>
  walletService?: Pick<WalletService, 'findDebitByIdempotencyKey'>
  transactionReadRepo?: Repository<Transaction>
  dataSource?: DataSource
  inProcessLocks?: Map<string, Promise<void>>
  logger?: { error: (message: string) => void }
  createOrRenewSubscription: (
    req: CheckoutRequest,
    payment: Payment,
  ) => Promise<{ subscription: Subscription; extended: boolean }>
  assignPlanInRoles: (brandId: string, planSlug: string, expiresAt?: Date) => Promise<void>
  auditService: Pick<AuditService, 'log'>
  eventBus: Pick<EventBusService, 'publishPaymentCompleted' | 'notifyPaymentSuccess'>
}

export interface WalletPaymentReconciliationResult {
  outcome: 'completed' | 'failed_without_debit' | 'noop'
  status: string
  subscriptionId?: string
}

export function getWalletDebitIdempotencyKey(paymentId: string): string {
  return `payment:${paymentId}:debit`
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
        await queryRunner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `wallet-reconcile:${paymentId}`,
        ])
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

async function findConflictingActivePlanSubscription(
  payment: Payment,
  deps: Pick<WalletPaymentReconciliationDeps, 'subscriptionRepo' | 'paymentRepo' | 'dataSource'>,
): Promise<Subscription | null> {
  const subRepo =
    deps.subscriptionRepo ??
    (typeof (deps.dataSource as any)?.getRepository === 'function'
      ? deps.dataSource!.getRepository(Subscription)
      : undefined)
  if (typeof subRepo?.findOne !== 'function') {
    return null
  }
  const existingSub = await subRepo.findOne({ where: { brandId: payment.brandId } })
  if (
    !existingSub ||
    existingSub.status !== SubscriptionStatus.ACTIVE ||
    !existingSub.planSlug ||
    existingSub.planSlug === payment.purposeId ||
    existingSub.lastPaymentId === payment.id
  ) {
    return null
  }
  if (existingSub.lastPaymentId && typeof deps.paymentRepo?.findOne === 'function') {
    const lastPayment = await deps.paymentRepo.findOne({
      where: { id: existingSub.lastPaymentId },
    })
    if (lastPayment) {
      const lastTime = new Date(lastPayment.paidAt ?? lastPayment.createdAt).getTime()
      const paymentTime = new Date(payment.createdAt).getTime()
      if (Number.isFinite(lastTime) && Number.isFinite(paymentTime) && lastTime < paymentTime) {
        return null
      }
    }
  }
  return existingSub
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

    if (payment.status === PaymentStatus.COMPLETED || payment.status === PaymentStatus.FAILED) {
      return { outcome: 'noop', status: payment.status }
    }

    if (payment.status !== PaymentStatus.PENDING && payment.status !== PaymentStatus.PROCESSING) {
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

    const totalAmount = Math.round(parseFloat(String(payment.amount || 0)) * 100) / 100
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

    if (payment.purpose === PaymentPurpose.PLAN_PURCHASE && payment.purposeId) {
      const conflictingSub = await findConflictingActivePlanSubscription(payment, deps)
      if (conflictingSub) {
        deps.logger?.error(
          `reconcileWalletPayment: brand ${payment.brandId} already has active plan ` +
            `${conflictingSub.planSlug}; keeping payment ${payment.id} (${payment.purposeId}) in processing`,
        )
        return { outcome: 'noop', status: PaymentStatus.PROCESSING }
      }

      const { subscription: sub, extended } = await deps.createOrRenewSubscription(req, payment)
      result.subscriptionId = sub.id
      if (extended && sub.currentPeriodEnd) {
        result.renewal = 'extended'
        result.currentPeriodEnd = sub.currentPeriodEnd
      }

      await deps.assignPlanInRoles(
        payment.brandId,
        sub?.planSlug || payment.purposeId,
        sub?.currentPeriodEnd,
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

    const paidAt = new Date()
    const updatedMetadata = payment.idempotencyKey
      ? {
          ...(payment.metadata || {}),
          checkoutResult: result,
        }
      : payment.metadata

    const completed = await deps.paymentRepo.update(
      { id: payment.id, status: PaymentStatus.PROCESSING },
      {
        status: PaymentStatus.COMPLETED,
        paidAt,
        ...(payment.idempotencyKey ? { metadata: updatedMetadata } : {}),
      },
    )
    if (!completed.affected) {
      return { outcome: 'noop', status: PaymentStatus.COMPLETED }
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
  } finally {
    await releaseLock()
  }
}
