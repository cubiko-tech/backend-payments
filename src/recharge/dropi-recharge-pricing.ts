import { TOKEN_PRICE_USD } from './token-price'

/** The TRM a recharge is priced and stored with: `payments.exchangeRate` keeps two decimals. */
export function storedRate(rate: number): number {
  return Math.round(rate * 100) / 100
}

/**
 * Pesos of `tokens` at `rate` COP per USD plus `taxRate` (0.19 = 19 %), rounded up to the whole
 * peso. Priced with the TRM as stored, so the payment can be recomputed from its own row.
 */
export function rechargePesos(tokens: number, rate: number, taxRate: number): number {
  return Math.ceil(tokens * TOKEN_PRICE_USD * storedRate(rate) * (1 + taxRate))
}
