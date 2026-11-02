import { HttpStatus, Logger } from '@nestjs/common'
import { DataSource, EntityManager, QueryRunner } from 'typeorm'

import { Payment, PaymentPurpose, PaymentStatus } from '../payment/entities/payment.entity'
import { lockPayment } from '../payment/payment-lock'
import { RequestException } from '../shared/exception/request.exception'
import { Subscription } from '../subscription/entities/subscription.entity'
import type { CheckoutRequest } from './checkout.service'
import {
  findConflictingPlanSubscription,
  WALLET_CLOSE_GIVEN_UP_FLAG,
} from './wallet-payment-reconciliation'

const log = new Logger('WalletPaymentClose')

/** Rolls back without ever throwing, so the error that caused it is the one the caller sees. */
export async function rollbackQuietly(runner: QueryRunner) {
  try {
    if (runner.isTransactionActive) {
      await runner.rollbackTransaction()
    }
  } catch (error) {
    log.error(`Rollback failed: ${error?.message ?? error}`)
  }
}

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

/** Serializes the closes that decide a brand's plan, until `runner`'s transaction ends. */
export async function lockBrandPlan(runner: QueryRunner, brandId: string) {
  await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wallet-plan:${brandId}`])
}

/** A newer purchase of another plan, already debited, that has not finished closing. */
export async function hasNewerDebitedPurchase(payment: Payment, manager: EntityManager) {
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
 * Hands back to its sweep every older purchase of another plan, from any provider, that closed
 * while this one was already open: they overlapped, so the newer wins and the older is credited.
 * Purchases that did not overlap are plain plan changes and keep their money spent.
 * Looks in the subscription events because `lastPaymentId` only names the newest purchase.
 */
export async function yieldOverlappedOlderPurchase(payment: Payment, manager: EntityManager) {
  await manager.query(
    `UPDATE payments p SET status = $1
     FROM subscriptions s
     JOIN subscription_events e ON e."subscriptionId" = s.id
     WHERE s."brandId" = $2 AND p.id = e."paymentId" AND p.status = $3
       AND p.purpose = $4 AND p."purposeId" <> $5 AND p."paidAt" > $6 AND p."createdAt" < $6`,
    [
      PaymentStatus.PROCESSING,
      payment.brandId,
      PaymentStatus.COMPLETED,
      PaymentPurpose.PLAN_PURCHASE,
      payment.purposeId,
      payment.createdAt,
    ],
  )
}

/**
 * Moves a failed payment back to `pending` for a retry, unless its money was already
 * credited back: completing it then would give the plan for free. Takes the payment
 * lock, so it waits for a sweep that is crediting the payment.
 *
 * A payment with a debit keeps its `createdAt`: the purchase happened then, and a newer
 * one still wins over it at the close. One without a debit is a new purchase from
 * `retriedAt`. Returns the claim result and the `createdAt` the payment ended up with.
 */
export async function claimFailedPaymentForRetry(
  paymentId: string,
  values: Partial<Payment>,
  retriedAt: Date,
  dataSource: DataSource,
): Promise<{ affected?: number | null; createdAt?: Date }> {
  const runner = dataSource.createQueryRunner()
  await runner.connect()
  await runner.startTransaction()
  try {
    await lockPayment(runner, paymentId)
    const credits = await runner.manager.query(
      'SELECT 1 FROM transactions WHERE "idempotencyKey" = $1 LIMIT 1',
      [`payment:${paymentId}:refund`],
    )
    const givenUp = await runner.manager.query(
      'SELECT 1 FROM payments WHERE id = $1 AND metadata->>$2 = $3 LIMIT 1',
      [paymentId, WALLET_CLOSE_GIVEN_UP_FLAG, 'true'],
    )
    if (credits.length > 0 || givenUp.length > 0) {
      throw new WalletCheckoutLostError(
        { code: 'WALLET_DEBIT_FAILED', message: `Payment ${paymentId} was credited back` },
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }
    const debits = await runner.manager.query(
      'SELECT 1 FROM transactions WHERE "idempotencyKey" = $1 LIMIT 1',
      [`payment:${paymentId}:debit`],
    )
    const createdAt = debits.length > 0 ? undefined : retriedAt
    const claimed = await runner.manager
      .getRepository(Payment)
      .update(
        { id: paymentId, status: PaymentStatus.FAILED },
        createdAt ? { ...values, createdAt } : values,
      )
    await runner.commitTransaction()
    return { affected: claimed.affected, createdAt }
  } catch (error) {
    await rollbackQuietly(runner)
    throw error
  } finally {
    await runner.release()
  }
}

/** Reads a payment once any sweep working on it has finished, since it holds this lock. */
export async function readPaymentAfterSweep(paymentId: string, dataSource: DataSource) {
  const runner = dataSource.createQueryRunner()
  await runner.connect()
  await runner.startTransaction()
  try {
    await lockPayment(runner, paymentId)
    return await runner.manager.getRepository(Payment).findOne({ where: { id: paymentId } })
  } finally {
    await rollbackQuietly(runner)
    await runner.release()
  }
}

/**
 * Closes a debited wallet payment under the per-brand lock: moves it to `completed`
 * and saves the subscription in one transaction on one connection, so no HTTP call
 * and no second connection may happen inside. Across purchases of different plans,
 * the newest `createdAt` wins whatever the finishing order.
 *
 * Returns `superseded` when a newer purchase wins, leaving the payment untouched for
 * the sweep to credit, and `already_closed` when it left the status the caller holds
 * (`pending` for a checkout, `processing` for the sweep that claimed it), so a checkout
 * never completes a payment the sweep owns. Throws, with nothing written, if saving the
 * subscription fails.
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
    await lockBrandPlan(runner, payment.brandId)
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
      await yieldOverlappedOlderPurchase(payment, runner.manager)
    }

    const closed = isPlanPurchase
      ? await deps.createOrRenewSubscription(req, payment, runner.manager)
      : { extended: false }

    const paidAt = new Date()
    const claimed = await paymentRepo.update(
      { id: payment.id, status: payment.status },
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
    await rollbackQuietly(runner)
    throw error
  } finally {
    await runner.release()
  }
}
