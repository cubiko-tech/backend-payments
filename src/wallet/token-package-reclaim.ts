import { HttpStatus } from '@nestjs/common'
import { EntityManager } from 'typeorm'

import { Payment, PaymentPurpose } from '../payment/entities/payment.entity'
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from './entities/wallet.entity'
import { isTokenCurrency } from './token-origin'
import { fromCents, toCents } from './token-spend'
import { fail } from './token-wallet.service'

/** The tokens a completed package payment credited, in cents. */
export interface PackageTokens {
  purchased: number
  gift: number
}

export const refundTokensKey = (refundId: string) => `refund:${refundId}:tokens`

export const isTokenPackage = (payment: Pick<Payment, 'purpose'>) =>
  payment.purpose === PaymentPurpose.TOKEN_PACKAGE

export const tokensSpent = () =>
  fail(
    'TOKEN_PACKAGE_TOKENS_SPENT',
    'The tokens of this package are no longer in the brand wallet',
    HttpStatus.UNPROCESSABLE_ENTITY,
  )

/** What the payment's package snapshot credited, or `null` when the payment has none. */
export function packageTokensOf(payment: Payment): PackageTokens | null {
  const snapshot = payment.metadata?.tokenPackage
  if (!snapshot || !payment.walletId) return null
  return {
    purchased: toCents(snapshot.purchasedTokens),
    gift: toCents(snapshot.bonusTokens ?? 0),
  }
}

/**
 * True when `wallet` is the payment's open token wallet and still holds the package: its paid
 * tokens in `purchased`, its bonus in `gift`, and both in `balance`. A frozen wallet counts.
 */
export function holdsPackageTokens(
  wallet: Wallet | null,
  payment: Payment,
  tokens: PackageTokens | null,
): tokens is PackageTokens {
  if (!wallet || !tokens) return false
  return (
    wallet.brandId === payment.brandId &&
    isTokenCurrency(wallet.currency) &&
    wallet.status !== WalletStatus.CLOSED &&
    toCents(wallet.purchasedTokens) >= tokens.purchased &&
    toCents(wallet.giftTokens) >= tokens.gift &&
    toCents(wallet.balance) >= tokens.purchased + tokens.gift
  )
}

/**
 * Takes back what a package payment credited: its paid tokens from `purchased` and its bonus
 * from `gift`, as one debit keyed by the refund. Runs on `manager`, which must be inside the
 * transaction that approves the refund; refuses with 422 when the wallet no longer holds them.
 */
export async function reclaimPackageTokens(
  manager: EntityManager,
  payment: Payment,
  refundId: string,
): Promise<Transaction> {
  const tokens = packageTokensOf(payment)
  const found = tokens
    ? await manager.findOne(Wallet, {
        where: { id: payment.walletId },
        lock: { mode: 'pessimistic_write' },
      })
    : null
  if (!holdsPackageTokens(found, payment, tokens)) throw tokensSpent()
  const wallet = found as Wallet

  const balanceBefore = toCents(wallet.balance)
  const total = tokens.purchased + tokens.gift
  wallet.purchasedTokens = fromCents(toCents(wallet.purchasedTokens) - tokens.purchased)
  wallet.giftTokens = fromCents(toCents(wallet.giftTokens) - tokens.gift)
  wallet.balance = fromCents(balanceBefore - total)
  await manager.save(Wallet, wallet)
  return manager.save(
    Transaction,
    manager.create(Transaction, {
      walletId: wallet.id,
      brandId: payment.brandId,
      type: TransactionType.DEBIT,
      amount: fromCents(total),
      balanceBefore: fromCents(balanceBefore),
      balanceAfter: wallet!.balance,
      status: TransactionStatus.COMPLETED,
      category: 'token_package_refund',
      description: 'Token package refund',
      referenceType: 'refund',
      referenceId: refundId,
      tokenOrigin: null,
      metadata: {
        paymentId: payment.id,
        tokenSplit: {
          gift: fromCents(tokens.gift),
          purchased: fromCents(tokens.purchased),
          dropi: 0,
        },
      },
      idempotencyKey: refundTokensKey(refundId),
    }),
  )
}
