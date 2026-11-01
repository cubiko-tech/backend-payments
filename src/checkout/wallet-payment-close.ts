import { DataSource, EntityManager, In } from 'typeorm'

import { Payment, PaymentPurpose, PaymentStatus } from '../payment/entities/payment.entity'
import { RequestException } from '../shared/exception/request.exception'
import { Subscription } from '../subscription/entities/subscription.entity'
import type { CheckoutRequest } from './checkout.service'
import { findConflictingPlanSubscription } from './wallet-payment-reconciliation'

/** The checkout lost its payment to the sweep, a cancellation or a newer purchase. */
export class WalletCheckoutLostError extends RequestException {}

export type WalletCloseResult =
  | { outcome: 'completed'; paidAt: Date; subscription?: Subscription; extended: boolean }
  | { outcome: 'superseded' }
  | { outcome: 'already_closed'; payment: Payment | null }

export interface WalletCloseDeps {
  dataSource: DataSource
  createOrRenewSubscription: (
    req: CheckoutRequest,
    payment: Payment,
    manager: EntityManager,
  ) => Promise<{ subscription: Subscription; extended: boolean }>
}

/** A newer purchase of another plan, already debited, that has not finished closing. */
async function hasNewerDebitedPurchase(payment: Payment, manager: EntityManager) {
  const rows = await manager.query(
    `SELECT 1 FROM payments p
     JOIN transactions t ON t."idempotencyKey" = 'payment:' || p.id || ':debit'
     WHERE p."brandId" = $1 AND p.purpose = $2 AND p."purposeId" <> $3 AND p."createdAt" > $4
       AND p.status IN ($5, $6)
     LIMIT 1`,
    [
      payment.brandId,
      PaymentPurpose.PLAN_PURCHASE,
      payment.purposeId,
      payment.createdAt,
      PaymentStatus.PENDING,
      PaymentStatus.PROCESSING,
    ],
  )
  return rows.length > 0
}

/**
 * Closes a debited wallet payment under the per-brand lock: moves it to `completed`
 * and saves the subscription in one transaction on one connection, so no HTTP call
 * and no second connection may happen inside. Across purchases of different plans,
 * the newest `createdAt` wins whatever the finishing order.
 *
 * Returns `superseded` when a newer purchase wins, leaving the payment untouched for
 * the sweep to credit, and `already_closed` when it is no longer open. Throws, with
 * nothing written, if saving the subscription fails.
 */
export async function closeWalletPayment(
  payment: Payment,
  req: CheckoutRequest,
  deps: WalletCloseDeps,
): Promise<WalletCloseResult> {
  const runner = deps.dataSource.createQueryRunner()
  await runner.connect()
  await runner.startTransaction()
  try {
    await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `wallet-plan:${payment.brandId}`,
    ])
    const paymentRepo = runner.manager.getRepository(Payment)
    const isPlanPurchase = payment.purpose === PaymentPurpose.PLAN_PURCHASE && !!payment.purposeId
    if (isPlanPurchase) {
      const conflict = await findConflictingPlanSubscription(payment, {
        subscriptionRepo: runner.manager.getRepository(Subscription),
        paymentRepo,
      })
      if (conflict || (await hasNewerDebitedPurchase(payment, runner.manager))) {
        await runner.rollbackTransaction()
        return { outcome: 'superseded' }
      }
    }

    const closed = isPlanPurchase
      ? await deps.createOrRenewSubscription(req, payment, runner.manager)
      : { extended: false }

    const paidAt = new Date()
    const claimed = await paymentRepo.update(
      { id: payment.id, status: In([PaymentStatus.PENDING, PaymentStatus.PROCESSING]) },
      { status: PaymentStatus.COMPLETED, paidAt },
    )
    if (!claimed.affected) {
      const latest = await paymentRepo.findOne({ where: { id: payment.id } })
      await runner.rollbackTransaction()
      return { outcome: 'already_closed', payment: latest }
    }

    await runner.commitTransaction()
    return { outcome: 'completed', paidAt, ...closed }
  } catch (error) {
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction()
    }
    throw error
  } finally {
    await runner.release()
  }
}
