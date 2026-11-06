/** Where a token credit came from; it decides the order a token debit spends it in. */
export enum TokenOrigin {
  GIFT = 'gift',
  PURCHASED = 'purchased',
  DROPI = 'dropi',
}

export const TOKEN_CURRENCY = 'TKN'

export function isTokenCurrency(currency: unknown): boolean {
  return typeof currency === 'string' && currency.trim().toUpperCase() === TOKEN_CURRENCY
}
