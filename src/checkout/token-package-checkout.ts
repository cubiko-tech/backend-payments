import { HttpStatus } from '@nestjs/common'

import { Payment } from '../payment/entities/payment.entity'
import { isTokenAmount, MAX_DROPI_RECHARGE_TOKENS } from '../recharge/dto/create-dropi-recharge.dto'
import { TOKEN_PRICE_USD } from '../recharge/token-price'
import { UsdCopRate } from '../trm/trm.service'
import { WalletStatus } from '../wallet/entities/wallet.entity'
import { TokenOrigin } from '../wallet/token-origin'
import { TokenPackageService, TokenPackageView } from '../wallet/token-package.service'
import { TokenWalletService, fail } from '../wallet/token-wallet.service'

export const MIN_CHECKOUT_TOKENS = 10
export const MAX_CHECKOUT_TOKENS = MAX_DROPI_RECHARGE_TOKENS

/** What the payment keeps of the package it bought; completion credits this, never the catalog. */
export interface TokenPackageSnapshot {
  packageId: string
  slug: string
  priceUsd: number
  purchasedTokens: number
  bonusTokens: number
}

/** What the payment keeps of a free-amount token purchase; completion credits this snapshot. */
export interface TokenAmountSnapshot {
  priceUsd: number
  purchasedTokens: number
}

export interface PreparedTokenPackage {
  amount: number
  currency: 'COP' | 'USD'
  country: string
  rate?: UsdCopRate
  walletId: string
  snapshot: TokenPackageSnapshot
}

export interface PreparedTokenAmount {
  amount: number
  currency: 'COP' | 'USD'
  country: string
  rate?: UsdCopRate
  walletId: string
  snapshot: TokenAmountSnapshot
}

export interface TokenPackageDeps {
  tokenPackages?: TokenPackageService
  tokenWallets?: TokenWalletService
  billingCountry: (brandId: string) => Promise<string>
  /** Rejects when the request's provider is not enabled for `country`. */
  assertProviderAvailable: (country: string) => Promise<void>
  quoteUsdCopRate: () => Promise<UsdCopRate>
  allowedReturnUrls?: string
}

export const purchasedTokensKey = (paymentId: string) => `payment:${paymentId}:tokens:purchased`
export const bonusTokensKey = (paymentId: string) => `payment:${paymentId}:tokens:gift`

/**
 * Prices a `token_package` checkout from the catalog and opens the brand token wallet, before
 * the payment exists. A Colombian billing country pays in COP at the day's TRM; any other pays
 * the USD price. Rejects, with nothing saved: `provider: 'wallet'` (422), an unknown or
 * inactive package (404), a provider not enabled for the country (400, checked before the TRM),
 * no TRM (503) and a closed token wallet (422).
 */
export async function prepareTokenPackage(
  req: {
    brandId: string
    userId: string
    provider: string
    packageId?: string
    tokens?: unknown
  },
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
  if (req.tokens !== undefined) {
    throw fail(
      'CONFLICTING_TOKEN_FIELDS',
      'tokens and packageId cannot be combined',
      HttpStatus.BAD_REQUEST,
    )
  }
  if (typeof req.packageId !== 'string' || !req.packageId) {
    throw fail('MISSING_PACKAGE_ID', 'packageId is required', HttpStatus.BAD_REQUEST)
  }
  const tokenPackage = await deps.tokenPackages.findActive(req.packageId)
  const country = String(await deps.billingCountry(req.brandId)).toUpperCase()
  await deps.assertProviderAvailable(country)
  const pricing = await chargeFor(tokenPackage.priceUsd, country, deps)

  const wallet = await openBrandTokenWallet(req.brandId, req.userId, deps.tokenWallets)
  return { ...pricing, country, walletId: wallet.id, snapshot: snapshotOf(tokenPackage) }
}

/**
 * Prices a `token_amount` checkout at `tokens * TOKEN_PRICE_USD` (converted to COP at the day's
 * TRM when the brand bills in CO), validates `successUrl` and `cancelUrl` against the allowlist,
 * and opens the brand token wallet before saving the payment.
 */
export async function prepareTokenAmount(
  req: {
    brandId: string
    userId: string
    provider: string
    tokens?: unknown
    packageId?: unknown
    successUrl?: string
    cancelUrl?: string
  },
  deps: TokenPackageDeps,
): Promise<PreparedTokenAmount> {
  if (req.provider === 'wallet') {
    throw fail(
      'TOKEN_PACKAGE_EXTERNAL_ONLY',
      'Token purchases are paid through an external provider',
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
  if (!deps.tokenWallets) {
    throw fail(
      'TOKEN_PACKAGE_UNAVAILABLE',
      'Token wallet is not available',
      HttpStatus.SERVICE_UNAVAILABLE,
    )
  }
  if (req.packageId !== undefined) {
    throw fail(
      'CONFLICTING_TOKEN_FIELDS',
      'tokens and packageId cannot be combined',
      HttpStatus.BAD_REQUEST,
    )
  }
  if (req.tokens === undefined || req.tokens === null) {
    throw fail('MISSING_TOKENS', 'tokens is required', HttpStatus.BAD_REQUEST)
  }
  if (
    typeof req.tokens !== 'number' ||
    !isTokenAmount(req.tokens) ||
    req.tokens < MIN_CHECKOUT_TOKENS ||
    req.tokens > MAX_CHECKOUT_TOKENS
  ) {
    throw fail(
      'INVALID_TOKEN_AMOUNT',
      `tokens must be between ${MIN_CHECKOUT_TOKENS} and ${MAX_CHECKOUT_TOKENS} with at most 2 decimals`,
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
  assertAllowedReturnUrls(
    req.successUrl,
    req.cancelUrl,
    deps.allowedReturnUrls ?? process.env.TOKEN_CHECKOUT_ALLOWED_RETURN_URLS,
  )

  const priceUsd = Math.round(req.tokens * TOKEN_PRICE_USD * 100) / 100
  const country = String(await deps.billingCountry(req.brandId)).toUpperCase()
  await deps.assertProviderAvailable(country)
  const pricing = await chargeFor(priceUsd, country, deps)
  const wallet = await openBrandTokenWallet(req.brandId, req.userId, deps.tokenWallets)
  return {
    ...pricing,
    country,
    walletId: wallet.id,
    snapshot: { priceUsd, purchasedTokens: req.tokens },
  }
}

export function parseAllowedReturnUrls(raw?: string): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * A return URL is allowed when it equals an entry, or when the entry is a bare origin
 * (`https://host[:port]`, nothing after it) and the URL is an http(s) page of that origin with no
 * user info, query or fragment. A bare origin lets the front return to whatever page it is on.
 */
export function isAllowedReturnUrl(candidate: unknown, allowed: string[]): boolean {
  if (typeof candidate !== 'string') return false
  if (allowed.includes(candidate)) return true
  const url = parseUrl(candidate)
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    return false
  if (url.search || url.hash || candidate.includes('?') || candidate.includes('#')) return false
  return allowed.some((entry) => parseUrl(entry)?.origin === entry && entry === url.origin)
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

export function assertAllowedReturnUrls(
  successUrl: string | undefined,
  cancelUrl: string | undefined,
  rawAllowed?: string,
) {
  const allowed = parseAllowedReturnUrls(rawAllowed)
  if (allowed.length === 0) {
    throw fail(
      'TOKEN_CHECKOUT_RETURN_URLS_NOT_CONFIGURED',
      'TOKEN_CHECKOUT_ALLOWED_RETURN_URLS is not configured',
      HttpStatus.SERVICE_UNAVAILABLE,
    )
  }
  if (!isAllowedReturnUrl(successUrl, allowed)) {
    throw fail(
      'INVALID_RETURN_URL',
      'successUrl is not in TOKEN_CHECKOUT_ALLOWED_RETURN_URLS',
      HttpStatus.BAD_REQUEST,
    )
  }
  if (cancelUrl !== undefined && !isAllowedReturnUrl(cancelUrl, allowed)) {
    throw fail(
      'INVALID_RETURN_URL',
      'cancelUrl is not in TOKEN_CHECKOUT_ALLOWED_RETURN_URLS',
      HttpStatus.BAD_REQUEST,
    )
  }
}

async function openBrandTokenWallet(
  brandId: string,
  userId: string,
  tokenWallets: TokenWalletService,
) {
  const wallet = await tokenWallets.getOrCreate(brandId, userId)
  if (wallet.status === WalletStatus.CLOSED) {
    throw fail('WALLET_CLOSED', 'The brand token wallet is closed', HttpStatus.UNPROCESSABLE_ENTITY)
  }
  return wallet
}

async function chargeFor(priceUsd: number, country: string, deps: TokenPackageDeps) {
  if (country !== 'CO') {
    return { amount: priceUsd, currency: 'USD' as const }
  }
  const rate = await deps.quoteUsdCopRate()
  const amount = Math.round(priceUsd * rate.rate * 100) / 100
  return { amount, currency: 'COP' as const, rate }
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

/**
 * Credits a completed free-amount token purchase as `purchased` from the snapshot stored on the
 * payment. Keyed by `purchasedTokensKey(payment.id)`, so repeated completions credit nothing new.
 */
export async function creditTokenAmount(payment: Payment, tokenWallets?: TokenWalletService) {
  const snapshot: TokenAmountSnapshot | undefined = payment.metadata?.tokenAmount
  if (!tokenWallets || !snapshot || !payment.walletId) {
    throw new Error(`Payment ${payment.id} cannot credit its token amount`)
  }
  await tokenWallets.creditTokens(
    payment.walletId,
    Number(snapshot.purchasedTokens),
    TokenOrigin.PURCHASED,
    {
      brandId: payment.brandId,
      category: 'token_amount',
      description: `Token purchase (${Number(snapshot.purchasedTokens)} tokens)`,
      referenceType: 'payment',
      referenceId: payment.id,
    },
    purchasedTokensKey(payment.id),
  )
}
