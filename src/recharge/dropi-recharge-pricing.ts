import { fromCents, toCents } from '../wallet/token-spend'
import { TOKEN_PRICE_USD } from './token-price'

/** The TRM a recharge is priced and stored with: `payments.exchangeRate` keeps two decimals. */
export function storedRate(rate: number): number {
  return Math.round(rate * 100) / 100
}

/** `tokens` at the two decimals a token wallet keeps; float noise below the hundredth goes. */
export function exactTokens(tokens: number): number {
  return fromCents(toCents(tokens))
}

// Hundredths of a token × USD cents × TRM cents.
const PRICE_DIVISOR = 100n * 100n * 100n

/**
 * Pesos of `tokens` at `rate` COP per USD, rounded up to the whole peso. VAT is inside this price,
 * never added to it: the invoice splits it out (`breakDownTaxInclusiveAmount`). Priced with the TRM
 * as stored, so the payment can be recomputed from its own row, and in integers, so the ceiling is
 * exact.
 */
export function rechargePesos(tokens: number, rate: number): number {
  // BigInt: 1,000,000 tokens at TRM 10,000 make a numerator of ~1e16, past 2^53.
  const numerator =
    BigInt(toCents(tokens)) * BigInt(toCents(TOKEN_PRICE_USD)) * BigInt(toCents(storedRate(rate)))
  return Number((numerator + PRICE_DIVISOR - 1n) / PRICE_DIVISOR)
}
