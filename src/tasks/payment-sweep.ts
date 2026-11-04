import {
  And,
  DataSource,
  In,
  IsNull,
  LessThan,
  MoreThanOrEqual,
  Not,
  Raw,
  Repository,
} from 'typeorm'

import { checkoutExpiryHours } from '../checkout/checkout-expiry'
import { CheckoutService } from '../checkout/checkout.service'
import { LOST_TO_NEWER_PURCHASE_FLAG } from '../checkout/external-payment-close'
import {
  hasWalletPaymentDebit,
  WALLET_CLOSE_GIVEN_UP_FLAG,
  WALLET_FAILED_DEBIT_LOOKBACK_MS,
  WALLET_RECONCILE_MIN_AGE_MS,
} from '../checkout/wallet-payment-reconciliation'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payment/entities/payment.entity'
import { ProviderFactory } from '../provider/provider.factory'
import { ProviderPaymentNotFoundError } from '../provider/provider.interface'
import { logger } from '../shared/logger/logger'
import { Transaction } from '../transaction/entities/transaction.entity'
import { Wallet } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { WalletService } from '../wallet/wallet.service'

export interface PaymentSweepDeps {
  walletReadRepo: Repository<Wallet>
  snapshotRepo: Repository<WalletBalanceSnapshot>
  paymentRepo: Repository<Payment>
  transactionReadRepo: Repository<Transaction>
  dataSource: DataSource
  walletService: WalletService
  providerFactory: ProviderFactory
  checkoutService: CheckoutService
  CHECKOUT_EXPIRY_HOURS?: number
}

/**
 * Safety net for a lost webhook: asks each provider about its unsettled payments and completes
 * what it confirms. A `processing` payment with its plan applied is closed by
 * `settleLostExternalPayments`; one without it waits here for the provider to confirm.
 */
export async function reconcileExternalPayments(deps: PaymentSweepDeps): Promise<void> {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000)
  const pending = await deps.paymentRepo.find({
    where: {
      provider: Not(PaymentProvider.WALLET),
      status: In([PaymentStatus.PENDING, PaymentStatus.PROCESSING]),
      createdAt: LessThan(cutoff),
    },
  })

  if (pending.length === 0) return

  let completed = 0
  for (const p of pending) {
    try {
      if (!p.providerPaymentId) {
        if (
          p.status === PaymentStatus.PROCESSING &&
          (await deps.checkoutService.completeExternalPayment(p.id, { source: 'cron-reconcile' }))
        ) {
          completed++
        }
        continue
      }
      const real = await deps.providerFactory
        .getProvider(p.provider)
        .getPaymentStatus(p.providerPaymentId, p.id)
      if (real.status === 'completed') {
        const closed = await deps.checkoutService.completeExternalPayment(p.id, {
          source: 'cron-reconcile',
          providerStatus: real.metadata,
        })
        if (closed) completed++
      } else if (
        p.status === PaymentStatus.PROCESSING &&
        (real.status === 'failed' || real.status === 'refunded')
      ) {
        logger.log(
          'error',
          `[CRON] reconcileExternalPayments: payment ${p.id} was confirmed but ${p.provider} now answers ${real.status}`,
        )
      }
    } catch (error) {
      logger.log(
        'warn',
        `[CRON] reconcileExternalPayments: error with payment ${p.id}: ${error.message}`,
      )
    }
  }

  logger.log(
    'info',
    `[CRON] reconcileExternalPayments: ${pending.length} checked, ${completed} completed`,
  )
}

/**
 * Finishes external plan purchases that may have lost to a newer one, from any provider: handed
 * back after `completed` (they keep `paidAt`), judged lost with the credit still to be made, or
 * stuck after applying their plan (they have their event), which complete if they did not lose.
 */
export async function settleLostExternalPayments(deps: PaymentSweepDeps): Promise<void> {
  const base = {
    provider: Not(PaymentProvider.WALLET),
    purpose: PaymentPurpose.PLAN_PURCHASE,
    status: PaymentStatus.PROCESSING,
    createdAt: LessThan(new Date(Date.now() - WALLET_RECONCILE_MIN_AGE_MS)),
  }
  const lost = await deps.paymentRepo.find({
    where: [
      { ...base, paidAt: Not(IsNull()) },
      {
        ...base,
        metadata: Raw((metadata) => `(${metadata})->>'${LOST_TO_NEWER_PURCHASE_FLAG}' = 'true'`),
      },
      {
        ...base,
        id: Raw((id) => `EXISTS (SELECT 1 FROM subscription_events e WHERE e."paymentId" = ${id})`),
      },
    ],
  })
  for (const p of lost ?? []) {
    try {
      await deps.checkoutService.completeExternalPayment(p.id, { source: 'cron-settle-lost' })
    } catch (error) {
      logger.log(
        'warn',
        `[CRON] settleLostExternalPayments: error with payment ${p.id}: ${error.message}`,
      )
    }
  }
}

/**
 * Creates the credit note that a refund to the wallet left owing: its creation failed, the
 * process died first, or the invoice appeared after the refund. Read from the rows, not a mark.
 */
export async function retryMissingCreditNotes(deps: PaymentSweepDeps): Promise<void> {
  const owing = await deps.paymentRepo.find({
    where: {
      provider: Not(PaymentProvider.WALLET),
      purpose: PaymentPurpose.PLAN_PURCHASE,
      status: PaymentStatus.REFUNDED,
      id: Raw(
        (id) =>
          `EXISTS (SELECT 1 FROM invoices i WHERE i."paymentId" = ${id} AND i.type = 'invoice'
           AND NOT EXISTS (SELECT 1 FROM invoices n WHERE n."creditNoteForId" = i.id))`,
      ),
    },
  })
  for (const p of owing ?? []) {
    await deps.checkoutService.issueRefundCreditNote(p.id)
  }
}

/**
 * Reconciles unsettled or failed-with-debit wallet payments older than the minimum age cutoff.
 */
export async function reconcileWalletPayments(deps: PaymentSweepDeps): Promise<void> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - WALLET_RECONCILE_MIN_AGE_MS)
  const failedFloor = new Date(now.getTime() - WALLET_FAILED_DEBIT_LOOKBACK_MS)
  const pending = await deps.paymentRepo.find({
    where: [
      {
        provider: PaymentProvider.WALLET,
        status: In([PaymentStatus.PENDING, PaymentStatus.PROCESSING]),
        createdAt: LessThan(cutoff),
      },
      {
        provider: PaymentProvider.WALLET,
        status: PaymentStatus.FAILED,
        createdAt: And(LessThan(cutoff), MoreThanOrEqual(failedFloor)),
        id: Raw(
          (id) =>
            `EXISTS (SELECT 1 FROM transactions t WHERE t."idempotencyKey" = 'payment:' || ${id} || ':debit')`,
        ),
      },
      // A give-up already took the payment out of `processing`, which has no age floor.
      {
        provider: PaymentProvider.WALLET,
        status: PaymentStatus.FAILED,
        createdAt: LessThan(cutoff),
        metadata: Raw((metadata) => `(${metadata})->>'${WALLET_CLOSE_GIVEN_UP_FLAG}' = 'true'`),
      },
    ],
  })

  if (!pending || pending.length === 0) return

  let completed = 0
  let failed = 0
  let refunded = 0
  for (const p of pending) {
    try {
      const res = await deps.checkoutService.reconcileWalletPayment(p.id, now)
      if (res?.outcome === 'completed') {
        completed++
      } else if (res?.outcome === 'failed_without_debit') {
        failed++
      } else if (res?.outcome === 'refunded') {
        refunded++
      }
    } catch (error) {
      logger.log(
        'warn',
        `[CRON] reconcileWalletPayments: error with payment ${p.id}: ${error.message}`,
      )
    }
  }

  logger.log(
    'info',
    `[CRON] reconcileWalletPayments: ${pending.length} checked, ${completed} completed, ${failed} failed, ${refunded} refunded`,
  )
}

/**
 * Expires pending checkouts past the inactivity window when no wallet debit or provider
 * confirmation exists.
 */
export async function expirePendingCheckouts(deps: PaymentSweepDeps): Promise<void> {
  const expiryHours = deps.CHECKOUT_EXPIRY_HOURS ?? checkoutExpiryHours()
  const expiryTime = new Date()
  expiryTime.setHours(expiryTime.getHours() - expiryHours)

  const expiredPending = await deps.paymentRepo.find({
    where: {
      status: PaymentStatus.PENDING,
      createdAt: LessThan(expiryTime),
    },
  })

  if (!expiredPending || expiredPending.length === 0) {
    return
  }

  const expirableIds: string[] = []
  for (const payment of expiredPending) {
    const debited = await hasWalletPaymentDebit(payment, {
      walletService: deps.walletService,
      transactionReadRepo: deps.transactionReadRepo,
      dataSource: deps.dataSource,
    })
    if (!debited && (await providerLetsExpire(payment, deps))) {
      expirableIds.push(payment.id)
    }
  }

  if (expirableIds.length === 0) {
    return
  }

  const result = await deps.paymentRepo.update(
    {
      id: In(expirableIds),
      status: PaymentStatus.PENDING,
    },
    {
      status: PaymentStatus.FAILED,
      failureReason: 'Checkout expirado por inactividad',
    },
  )

  if ((result?.affected ?? 0) > 0) {
    logger.log('info', `[CRON] expirePendingCheckouts: ${result.affected} checkouts expirados`)
  }
}

/**
 * Verifies every active wallet balance against its completed transactions and records a snapshot.
 */
export async function reconcileWalletBalances(deps: PaymentSweepDeps): Promise<void> {
  logger.log('info', '[CRON] reconcileWalletBalances: iniciando')

  const wallets = await deps.walletReadRepo.find({
    where: { status: 'active' as any },
  })

  let inconsistent = 0
  const now = new Date()

  for (const wallet of wallets) {
    const result = await deps.dataSource.query(
      `
      SELECT
        COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) -
        COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS calculated,
        COUNT(*) AS count
      FROM transactions
      WHERE "walletId" = $1 AND status = 'completed'
    `,
      [wallet.id],
    )

    const calculatedBalance = parseFloat(result[0]?.calculated || '0')
    const transactionCount = parseInt(result[0]?.count || '0')
    const currentBalance = parseFloat(String(wallet.balance))
    const isConsistent = Math.abs(currentBalance - calculatedBalance) < 0.01

    await deps.snapshotRepo.save(
      deps.snapshotRepo.create({
        walletId: wallet.id,
        balance: currentBalance,
        calculatedBalance,
        transactionCount,
        isConsistent,
        snapshotAt: now,
      }),
    )

    if (!isConsistent) {
      inconsistent++
      logger.log(
        'error',
        `[CRON] DESCUADRE en wallet ${wallet.id}: balance=${currentBalance}, calculado=${calculatedBalance}, diff=${currentBalance - calculatedBalance}`,
      )
    }
  }

  logger.log(
    'info',
    `[CRON] reconcileWalletBalances: ${wallets.length} wallets verificadas, ${inconsistent} inconsistentes`,
  )
}

/** Only what the provider did not confirm expires; no answer leaves it for a later pass. */
async function providerLetsExpire(payment: Payment, deps: PaymentSweepDeps): Promise<boolean> {
  if (payment.provider === PaymentProvider.WALLET || !payment.providerPaymentId) return true
  try {
    const real = await deps.providerFactory
      .getProvider(payment.provider)
      .getPaymentStatus(payment.providerPaymentId, payment.id)
    return real.status !== 'completed' && real.status !== 'processing'
  } catch (error) {
    if (error instanceof ProviderPaymentNotFoundError) return true
    logger.log(
      'warn',
      `[CRON] expirePendingCheckouts: no answer for payment ${payment.id}: ${error.message}`,
    )
    return false
  }
}
