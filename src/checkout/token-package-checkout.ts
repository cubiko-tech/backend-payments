import { HttpStatus } from '@nestjs/common'

import { Payment } from '../payment/entities/payment.entity'
import { RequestException } from '../shared/exception/request.exception'
import { UsdCopRate } from '../trm/trm.service'
import { WalletStatus } from '../wallet/entities/wallet.entity'
import { TokenOrigin } from '../wallet/token-origin'
import { TokenPackageService, TokenPackageView } from '../wallet/token-package.service'
import { TokenWalletService } from '../wallet/token-wallet.service'

/** What the payment keeps of the package it bought; completion credits this, never the catalog. */
export interface TokenPackageSnapshot {
  packageId: string
  slug: string
  priceUsd: number
  purchasedTokens: number
  bonusTokens: number
}

export interface PreparedTokenPackage {
  amount: number
  currency: 'COP' | 'USD'
  country: string
  rate?: UsdCopRate
  exchangeRate?: 'USD_COP'
  walletId: string
  snapshot: TokenPackageSnapshot
}

export interface TokenPackageDeps {
  tokenPackages?: TokenPackageService
  tokenWallets?: TokenWalletService
  billingCountry: (brandId: string) => Promise<string>
  quoteUsdCopRate: () => Promise<UsdCopRate>
}

export const purchasedTokensKey = (paymentId: string) => `payment:${paymentId}:tokens:purchased`
export const bonusTokensKey = (paymentId: string) => `payment:${paymentId}:tokens:gift`

const fail = (code: string, message: string, status: HttpStatus) =>
  new RequestException({ code, message }, status)

/**
 * Prices a `token_package` checkout from the catalog and opens the brand token wallet, before
 * the payment exists. A Colombian billing country pays in COP at the day's TRM; any other pays
 * the USD price. Rejects, with nothing saved: `provider: 'wallet'` (422), an unknown or
 * inactive package (404), no TRM (503) and a closed token wallet (422).
 */
export async function prepareTokenPackage(
  req: { brandId: string; userId: string; provider: string; packageId?: string },
  deps: TokenPackageDeps,
): Promise<PreparedTokenPackage> {
  if (req.provider === 'wallet') {
    throw fail(
      'TOKEN_PACKAGE_EXTERNAL_ONLY',
      'Token packages are paid through an external provider',
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
  if (!deps.tokenPackages || !deps.tokenWallets) {
    throw fail(
      'TOKEN_PACKAGE_UNAVAILABLE',
      'Token packages are not available',
      HttpStatus.SERVICE_UNAVAILABLE,
    )
  }
  if (typeof req.packageId !== 'string' || !req.packageId) {
    throw fail('MISSING_PACKAGE_ID', 'packageId is required', HttpStatus.BAD_REQUEST)
  }
  const tokenPackage = await deps.tokenPackages.findActive(req.packageId)
  const country = String(await deps.billingCountry(req.brandId)).toUpperCase()
  const pricing = await chargeFor(tokenPackage, country, deps)

  const wallet = await deps.tokenWallets.getOrCreate(req.brandId, req.userId)
  if (wallet.status === WalletStatus.CLOSED) {
    throw fail('WALLET_CLOSED', 'The brand token wallet is closed', HttpStatus.UNPROCESSABLE_ENTITY)
  }
  return { ...pricing, country, walletId: wallet.id, snapshot: snapshotOf(tokenPackage) }
}

async function chargeFor(tokenPackage: TokenPackageView, country: string, deps: TokenPackageDeps) {
  if (country !== 'CO') {
    return { amount: tokenPackage.priceUsd, currency: 'USD' as const }
  }
  const rate = await deps.quoteUsdCopRate()
  const amount = Math.round(tokenPackage.priceUsd * rate.rate * 100) / 100
  return { amount, currency: 'COP' as const, rate, exchangeRate: 'USD_COP' as const }
}

function snapshotOf(tokenPackage: TokenPackageView): TokenPackageSnapshot {
  return {
    packageId: tokenPackage.id,
    slug: tokenPackage.slug,
    priceUsd: tokenPackage.priceUsd,
    purchasedTokens: tokenPackage.purchasedTokens,
    bonusTokens: tokenPackage.bonusTokens,
  }
}

/**
 * Credits a completed package: its paid tokens as `purchased` and its bonus as `gift`, from the
 * snapshot on the payment. Keyed by payment, so a completion that runs again credits nothing new.
 */
export async function creditTokenPackage(payment: Payment, tokenWallets?: TokenWalletService) {
  const snapshot: TokenPackageSnapshot | undefined = payment.metadata?.tokenPackage
  if (!tokenWallets || !snapshot || !payment.walletId) {
    throw new Error(`Payment ${payment.id} cannot credit its token package`)
  }
  const data = {
    brandId: payment.brandId,
    category: 'token_package',
    description: `Token package ${snapshot.slug}`,
    referenceType: 'payment',
    referenceId: payment.id,
  }
  await tokenWallets.creditTokens(
    payment.walletId,
    Number(snapshot.purchasedTokens),
    TokenOrigin.PURCHASED,
    data,
    purchasedTokensKey(payment.id),
  )
  if (Number(snapshot.bonusTokens) > 0) {
    await tokenWallets.creditTokens(
      payment.walletId,
      Number(snapshot.bonusTokens),
      TokenOrigin.GIFT,
      data,
      bonusTokensKey(payment.id),
    )
  }
}
