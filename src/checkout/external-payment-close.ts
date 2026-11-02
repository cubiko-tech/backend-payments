import { DataSource, EntityManager, In, QueryRunner, Repository } from 'typeorm'

import { AuditService } from '../audit/audit.service'
import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { Subscription } from '../subscription/entities/subscription.entity'
import {
  PLAN_APPLYING_EVENTS,
  SubscriptionEvent,
  SubscriptionEventType,
} from '../subscription/entities/subscriptionEvent.entity'
import { Wallet, WalletProvider } from '../wallet/entities/wallet.entity'
import { WalletService } from '../wallet/wallet.service'
import type { CheckoutRequest } from './checkout.service'
import {
  hasNewerDebitedPurchase,
  lockBrandPlan,
  PLAN_YIELD_WINDOW_MS,
  rollbackQuietly,
  yieldOverlappedOlderPurchase,
} from './wallet-payment-close'
import {
  acquireWalletReconcileLock,
  findConflictingPlanSubscription,
  getWalletRefundIdempotencyKey,
  hasWalletPaymentRefund,
  isHandedBackPurchase,
  refundSupersededWalletPayment,
  WalletPaymentReconciliationResult,
} from './wallet-payment-reconciliation'

/** `metadata` flag of an external purchase that lost its plan: it only ever gets credited. */
export const LOST_TO_NEWER_PURCHASE_FLAG = 'lostToNewerPurchase'

export type ExternalCloseResult =
  | { outcome: 'superseded' }
  | { outcome: 'applied'; subscription: Subscription; extended: boolean }

export interface LostPurchaseDeps {
  paymentRepo: Repository<Payment>
  walletService: Pick<WalletService, 'credit' | 'create' | 'findDebitByIdempotencyKey'>
  dataSource: DataSource
  inProcessLocks: Map<string, Promise<void>>
  auditService: Pick<AuditService, 'log'>
  logger: { error: (message: string) => void; warn: (message: string) => void }
}

/** Runs `work` in one transaction holding the per-brand plan lock of the wallet close. */
async function inBrandPlanLock<T>(
  brandId: string,
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const runner: QueryRunner = dataSource.createQueryRunner()
  await runner.connect()
  await runner.startTransaction()
  try {
    await lockBrandPlan(runner, brandId)
    const result = await work(runner.manager)
    await runner.commitTransaction()
    return result
  } catch (error) {
    await rollbackQuietly(runner)
    throw error
  } finally {
    await runner.release()
  }
}

function findPlanApplyingEvent(paymentId: string, manager: EntityManager) {
  return manager.getRepository(SubscriptionEvent).findOne({
    where: { paymentId, eventType: In(PLAN_APPLYING_EVENTS) },
  })
}

/**
 * Whether another purchase changed the plan within `PLAN_YIELD_WINDOW_MS` of this one applying it.
 * Stored times only: a retry days later must reach the verdict a timely one would have reached.
 */
async function displacedWithinWindow(event: SubscriptionEvent, manager: EntityManager) {
  const appliedAt = new Date(event.createdAt).getTime()
  const rows = await manager.query(
    `SELECT 1 FROM subscription_events
     WHERE "subscriptionId" = $1 AND "eventType" = $2 AND "paymentId" IS NOT NULL
       AND "paymentId" <> $3 AND "createdAt" > $4 AND "createdAt" <= $5
     LIMIT 1`,
    [
      event.subscriptionId,
      SubscriptionEventType.PLAN_CHANGED,
      event.paymentId,
      event.createdAt,
      new Date(appliedAt + PLAN_YIELD_WINDOW_MS),
    ],
  )
  return rows.length > 0
}

/**
 * Whether a newer purchase beat this one. Reads the row under the lock: a stale copy could
 * miss that it was already judged, and that verdict stands even if the newer one is refunded.
 * A purchase that applied only loses if its days were replaced within the window; one that did
 * not apply loses to any newer purchase of another plan.
 */
async function hasLostToNewerPurchase(payment: Payment, manager: EntityManager) {
  const paymentRepo = manager.getRepository(Payment)
  const current = (await paymentRepo.findOne({ where: { id: payment.id } })) ?? payment
  if (current.metadata?.[LOST_TO_NEWER_PURCHASE_FLAG]) {
    return true
  }
  const credits = await manager.query(
    'SELECT 1 FROM transactions WHERE "idempotencyKey" = $1 LIMIT 1',
    [getWalletRefundIdempotencyKey(payment.id)],
  )
  if (credits.length > 0) {
    return true
  }

  const subscriptionRepo = manager.getRepository(Subscription)
  const subscriptionEventRepo = manager.getRepository(SubscriptionEvent)
  if (await isHandedBackPurchase(current, { subscriptionRepo, subscriptionEventRepo })) {
    return true
  }
  const applied = await findPlanApplyingEvent(payment.id, manager)
  if (applied) {
    return displacedWithinWindow(applied, manager)
  }
  if (await findConflictingPlanSubscription(current, { subscriptionRepo, paymentRepo })) {
    return true
  }

  const sub = await subscriptionRepo.findOne({ where: { brandId: payment.brandId } })
  return sub?.lastPaymentId !== payment.id && hasNewerDebitedPurchase(current, manager)
}

/** Written as one key so that a concurrent writer of `metadata` cannot lose it. */
function markLost(paymentId: string, manager: EntityManager) {
  return manager.query(
    `UPDATE payments
     SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY[$2], 'true'::jsonb)
     WHERE id = $1`,
    [paymentId, LOST_TO_NEWER_PURCHASE_FLAG],
  )
}

/**
 * Applies a confirmed external plan purchase under the per-brand lock, so the newest `createdAt`
 * wins across providers whatever the confirmation order. A loser is flagged and nothing else is
 * written; a winner hands back the older purchases it overlapped with.
 */
export function closeExternalPlanPurchase(
  payment: Payment,
  req: CheckoutRequest,
  dataSource: DataSource,
  createOrRenewSubscription: (
    req: CheckoutRequest,
    payment: Payment,
    manager: EntityManager,
  ) => Promise<{ subscription: Subscription; extended: boolean }>,
): Promise<ExternalCloseResult> {
  return inBrandPlanLock(payment.brandId, dataSource, async (manager) => {
    if (await hasLostToNewerPurchase(payment, manager)) {
      await markLost(payment.id, manager)
      return { outcome: 'superseded' as const }
    }
    // Yielding and applying share this transaction: one that already applied already yielded.
    if (!(await findPlanApplyingEvent(payment.id, manager))) {
      await yieldOverlappedOlderPurchase(payment, manager)
    }
    const closed = await createOrRenewSubscription(req, payment, manager)
    return { outcome: 'applied' as const, ...closed }
  })
}

/** Whether the payment already gave something: a plan, a credit or an invoice. */
export async function hasPaymentTakenEffect(paymentId: string, dataSource: DataSource) {
  const rows = await dataSource.query(
    `SELECT 1 WHERE
       EXISTS (
         SELECT 1 FROM subscription_events
         WHERE "paymentId" = $1::uuid AND "eventType"::text = ANY($3::text[])
       )
       OR EXISTS (SELECT 1 FROM transactions WHERE "idempotencyKey" = ANY($2::text[]))
       OR EXISTS (SELECT 1 FROM invoices WHERE "paymentId" = $1::uuid)`,
    [
      paymentId,
      [`payment:${paymentId}:credit`, getWalletRefundIdempotencyKey(paymentId)],
      PLAN_APPLYING_EVENTS,
    ],
  )
  return rows.length > 0
}

/**
 * Moves an applied external plan purchase to `completed`, judging it again under the lock: a
 * newer purchase may have closed during the invoice calls, and no later close can see this one.
 */
export function completeExternalPlanPurchase(
  payment: Payment,
  paidAt: Date,
  dataSource: DataSource,
): Promise<'completed' | 'superseded' | 'not_processing'> {
  return inBrandPlanLock(payment.brandId, dataSource, async (manager) => {
    if (await hasLostToNewerPurchase(payment, manager)) {
      await markLost(payment.id, manager)
      return 'superseded' as const
    }
    const completed = await manager
      .getRepository(Payment)
      .update(
        { id: payment.id, status: PaymentStatus.PROCESSING },
        { status: PaymentStatus.COMPLETED, paidAt },
      )
    return completed.affected ? ('completed' as const) : ('not_processing' as const)
  })
}

/**
 * The brand's `internal` wallet in the payment's currency, created if it has none, or null if
 * that fails. Other providers' wallets are skipped: their balance may be mirrored. A closed one
 * is returned as is, and its credit refuses it.
 */
async function resolveRefundWallet(payment: Payment, deps: LostPurchaseDeps) {
  const unavailable = (why: string) => {
    deps.logger.error(
      `settleLostExternalPurchase: payment ${payment.id} cannot be credited to brand ` +
        `${payment.brandId} in ${payment.currency}: ${why}`,
    )
    return null
  }
  const provider = WalletProvider.INTERNAL as string
  const existing = await deps.dataSource.getRepository(Wallet).findOne({
    where: { brandId: payment.brandId, provider, currency: payment.currency },
  })
  if (existing) {
    return existing
  }
  try {
    const created = await deps.walletService.create({
      brandId: payment.brandId,
      userId: payment.userId,
      provider,
      currency: payment.currency,
    })
    return created.data ?? unavailable(`wallet creation failed: ${created.error}`)
  } catch (error: any) {
    return unavailable(`wallet creation failed: ${error?.message ?? error}`)
  }
}

/**
 * Credits a lost external purchase to the brand's wallet and moves it to `refunded`. Never throws
 * for a credit it cannot make: the payment stays `processing` and flagged, and the sweep retries.
 */
export async function settleLostExternalPurchase(
  paymentId: string,
  deps: LostPurchaseDeps,
): Promise<WalletPaymentReconciliationResult> {
  const releaseLock = await acquireWalletReconcileLock(
    paymentId,
    deps.dataSource,
    deps.inProcessLocks,
  )
  try {
    const payment = await deps.paymentRepo.findOne({ where: { id: paymentId } })
    if (payment?.status !== PaymentStatus.PROCESSING) {
      return { outcome: 'noop', status: payment?.status ?? 'not_found' }
    }
    // Ahead of the wallet: a credit already made must finish even if the wallet closed since.
    const refundRecorded = await hasWalletPaymentRefund(payment, { dataSource: deps.dataSource })
    if (!refundRecorded) {
      const wallet = await resolveRefundWallet(payment, deps)
      if (!wallet) {
        return { outcome: 'noop', status: payment.status }
      }
      payment.walletId = wallet.id
    }
    const totalAmount = Math.round(parseFloat(String(payment.amount || 0)) * 100) / 100
    const reason = 'a newer purchase took its plan'
    return await refundSupersededWalletPayment(
      payment,
      null,
      totalAmount,
      deps,
      refundRecorded,
      reason,
    )
  } finally {
    await releaseLock()
  }
}
