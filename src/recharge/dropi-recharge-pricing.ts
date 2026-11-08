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

// Hundredths of a token × USD cents × TRM cents × (10,000 + VAT basis points).
const PRICE_DIVISOR = 100n * 100n * 100n * 10_000n

/**
 * Pesos of `tokens` at `rate` COP per USD plus `taxRate` (0.19 = 19 %), rounded up to the whole
 * peso. Priced with the TRM as stored, so the payment can be recomputed from its own row, and in
 * integers, so the ceiling is exact.
 */
export function rechargePesos(tokens: number, rate: number, taxRate: number): number {
  // BigInt: 1,000,000 tokens at TRM 10,000 make a numerator of ~1.2e20, past 2^53.
  const numerator =
    BigInt(toCents(tokens)) *
    BigInt(toCents(TOKEN_PRICE_USD)) *
    BigInt(toCents(storedRate(rate))) *
    BigInt(10_000 + Math.round(taxRate * 10_000))
  return Number((numerator + PRICE_DIVISOR - 1n) / PRICE_DIVISOR)
}
