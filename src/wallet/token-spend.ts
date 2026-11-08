/** Token balance per origin, in cents so splits add up exactly. */
export interface TokenBuckets {
  gift: number
  purchased: number
  dropi: number
}

/**
 * Decides how a token debit of `amount` cents is drawn from `buckets`: gift first, then
 * purchased, and Dropi tokens last and only when the debit happens inside Dropi.
 * Returns what to take from each origin, or `null` when the spendable origins do not cover it.
 */
export function planTokenSpend(
  buckets: TokenBuckets,
  amount: number,
  inDropi: boolean,
): TokenBuckets | null {
  const order: (keyof TokenBuckets)[] = inDropi
    ? ['gift', 'purchased', 'dropi']
    : ['gift', 'purchased']
  const taken: TokenBuckets = { gift: 0, purchased: 0, dropi: 0 }
  let left = amount
  for (const origin of order) {
    taken[origin] = Math.min(buckets[origin], left)
    left -= taken[origin]
  }
  return left > 0 ? null : taken
}

/**
 * Decides how a refund of `amount` cents goes back to the origins a debit drew from: the reverse
 * of the spend, Dropi first, then purchased, then gift, never past what `remaining` still owes
 * each origin. Returns what to give back to each, or `null` when `remaining` does not cover it.
 */
export function planTokenRefund(remaining: TokenBuckets, amount: number): TokenBuckets | null {
  const given: TokenBuckets = { gift: 0, purchased: 0, dropi: 0 }
  let left = amount
  for (const origin of ['dropi', 'purchased', 'gift'] as const) {
    given[origin] = Math.min(Math.max(remaining[origin], 0), left)
    left -= given[origin]
  }
  return left > 0 ? null : given
}

export const toCents = (value: unknown) => Math.round(Number(value) * 100)
export const fromCents = (cents: number) => cents / 100
