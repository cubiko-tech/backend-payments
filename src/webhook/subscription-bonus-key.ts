import { ConfioWebhookPayload } from '../provider/confio/confio.types'
import { MAX_CONFIO_STRING_LENGTH } from '../provider/confio/confio-webhook-signature'

/** Prefix of every cycle bonus key in `transactions.idempotencyKey`; no other movement uses it. */
export const SUBSCRIPTION_BONUS_KEY_PREFIX = 'subscription-bonus'

/**
 * Key of the cycle bonus, built only from signed fields of the notice: its subscription and cycle.
 * `null` when either is missing, unsigned or malformed. Never from time: a redelivery must match.
 */
export function subscriptionBonusKey(payload: ConfioWebhookPayload): string | null {
  const data = payload?.data
  const signed = payload?.signature?.properties
  const isSigned = (prop: string) => Array.isArray(signed) && signed.includes(prop)
  if (!isSigned('name') || !isSigned('cycleNumber')) return null

  const name = data?.name
  const cycle = data?.cycleNumber
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_CONFIO_STRING_LENGTH) {
    return null
  }
  if (typeof cycle !== 'number' || !Number.isSafeInteger(cycle) || cycle < 0) return null

  return `${SUBSCRIPTION_BONUS_KEY_PREFIX}:${name}:ciclo-${cycle}`
}
