import { ConfioWebhookPayload } from '../provider/confio/confio.types'
import { ProviderWatermark, Subscription } from '../subscription/entities/subscription.entity'

/** The order of one Confio notice, read only from signed fields. */
export interface NoticeOrder {
  event: string | undefined
  /** Signed `cycleNumber` of a charge notice. */
  cycle?: number
  /** Signed envelope `timestamp`. */
  at?: Date
}

const CHARGE_EVENT = 'subscription.billingStatusChanged'

/**
 * Order of a notice. `updateTime` is never read: it is not signed and whoever forwards a notice could
 * move it. The envelope `timestamp` is always part of the checksum, in seconds or milliseconds.
 */
export function readNoticeOrder(payload: ConfioWebhookPayload): NoticeOrder {
  const signed = payload?.signature?.properties
  const cycle = payload?.data?.cycleNumber
  const signedCycle =
    payload?.event === CHARGE_EVENT &&
    Array.isArray(signed) &&
    signed.includes('cycleNumber') &&
    typeof cycle === 'number' &&
    Number.isSafeInteger(cycle) &&
    cycle >= 0

  const raw = payload?.timestamp
  const seconds = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  const ms = seconds >= 1e12 ? seconds : seconds * 1000
  const at = Number.isFinite(ms) && raw !== '' ? new Date(ms) : undefined

  return {
    event: payload?.event,
    ...(signedCycle ? { cycle } : {}),
    ...(at && !Number.isNaN(at.getTime()) ? { at } : {}),
  }
}

/**
 * The mark of the Confio subscription the row holds now, or `null`. A mark of another Confio
 * subscription does not count: the row is reused by a new signup, whose cycles restart at 1.
 */
function currentMark(sub: Subscription): ProviderWatermark | null {
  const mark = sub?.providerWatermark
  if (!mark) return null

  return (mark.name ?? null) === (sub.providerSubscriptionId ?? null) ? mark : null
}

/**
 * Whether the notice is older than the one already applied: its signed timestamp is before the
 * mark's, and it is not a charge of a later signed cycle. An equal timestamp is not older.
 *
 * The cycle alone never holds a notice back: a signed notice can be re-split so its cycle grows with
 * the same checksum (LOC-235 in `docs/RIESGOS.md`), and a cycle-only order would let that forged
 * cycle hold every real one after it. The timestamp cannot be moved past the 24 h signature window.
 */
export function isOutOfOrder(sub: Subscription, notice: NoticeOrder): boolean {
  const mark = currentMark(sub)
  const markAt = mark?.at ? new Date(mark.at) : undefined
  if (!notice.at || !markAt || notice.at.getTime() >= markAt.getTime()) return false

  const laterCycle =
    notice.event === CHARGE_EVENT &&
    notice.cycle !== undefined &&
    mark.cycle !== undefined &&
    notice.cycle > mark.cycle
  return !laterCycle
}

/** The mark after applying the notice: each field only moves forward. */
export function advanceMark(sub: Subscription, notice: NoticeOrder): ProviderWatermark {
  const mark = currentMark(sub)
  const cycles = [mark?.cycle, notice.event === CHARGE_EVENT ? notice.cycle : undefined].filter(
    (c): c is number => c !== undefined,
  )
  const times = [mark?.at ? new Date(mark.at).getTime() : undefined, notice.at?.getTime()].filter(
    (t): t is number => t !== undefined,
  )

  return {
    name: sub.providerSubscriptionId ?? null,
    ...(cycles.length ? { cycle: Math.max(...cycles) } : {}),
    ...(times.length ? { at: new Date(Math.max(...times)).toISOString() } : {}),
  }
}
