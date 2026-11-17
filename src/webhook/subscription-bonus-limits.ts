const DEFAULT_MAX_TOKENS = 10000
const DEFAULT_MAX_TOKENS_PER_MONTH = 20000

/** Caps of the subscription cycle bonus, in tokens: per credit, and per brand per UTC month. */
export interface SubscriptionBonusLimits {
  perCredit: number
  perMonth: number
}

/**
 * Reads `SUBSCRIPTION_BONUS_MAX_TOKENS` and `SUBSCRIPTION_BONUS_MAX_TOKENS_PER_MONTH`, their only
 * reader. Anything but a positive integer falls back to the default: a NaN cap would credit anything.
 */
export function subscriptionBonusLimits(): SubscriptionBonusLimits {
  return {
    perCredit: positiveInteger(process.env.SUBSCRIPTION_BONUS_MAX_TOKENS, DEFAULT_MAX_TOKENS),
    perMonth: positiveInteger(
      process.env.SUBSCRIPTION_BONUS_MAX_TOKENS_PER_MONTH,
      DEFAULT_MAX_TOKENS_PER_MONTH,
    ),
  }
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw || !/^\d+$/.test(raw.trim())) return fallback
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}
