import { ConfioWebhookPayload } from '../provider/confio/confio.types'
import { MAX_CONFIO_STRING_LENGTH } from '../provider/confio/confio-webhook-signature'
import { Subscription } from '../subscription/entities/subscription.entity'

/** Prefix of every cycle bonus key in `transactions.idempotencyKey`; no other movement uses it. */
export const SUBSCRIPTION_BONUS_KEY_PREFIX = 'subscription-bonus'

/**
 * Key of the cycle bonus: our subscription row, the Confio subscription stored on it, and the signed
 * cycle of the notice. `null` when the cycle is unsigned or malformed, or the row has no Confio
 * subscription. Never from `data.name`: the row is reused by a new signup, whose cycles restart at 1.
 */
export function subscriptionBonusKey(
  payload: ConfioWebhookPayload,
  sub: Pick<Subscription, 'id' | 'providerSubscriptionId'>,
): string | null {
  const data = payload?.data
  const signed = payload?.signature?.properties
  const isSigned = (prop: string) => Array.isArray(signed) && signed.includes(prop)
  if (!isSigned('name') || !isSigned('cycleNumber')) return null

  const confioName = sub?.providerSubscriptionId
  if (
    typeof confioName !== 'string' ||
    confioName.length === 0 ||
    confioName.length > MAX_CONFIO_STRING_LENGTH
  ) {
    return null
  }
  const cycle = data?.cycleNumber
  if (typeof cycle !== 'number' || !Number.isSafeInteger(cycle) || cycle < 0) return null

  return `${SUBSCRIPTION_BONUS_KEY_PREFIX}:${sub.id}:${confioName}:ciclo-${cycle}`
}
