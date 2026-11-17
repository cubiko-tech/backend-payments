/** What the cycle bonus rule reads, all measured under the subscription and wallet locks. */
export interface BonusRuleInput {
  /** Brand, plan and Confio subscription the bonus was planned with, before the lock. */
  planned: {
    brandId: string
    planSlug: string
    providerSubscriptionId: string
    cycleNumber: number
  }
  /** The same three fields on the locked subscription row. */
  locked: { brandId: string; planSlug: string; providerSubscriptionId: string }
  /** The locked token wallet, or `null` when it is gone. */
  wallet: { brandId: string; closed: boolean } | null
  keyUsed: boolean
  /** An applied movement of this subscription row already carries the notice's signed checksum. */
  checksumSeen: boolean
  /** Highest cycle already bonified for this row and its Confio subscription, `null` when none. */
  lastCycle: number | null
}

/**
 * Why the cycle bonus must not be credited, or `null` when it may. The first matching reason wins;
 * the token caps are checked afterwards by the caller.
 */
export function bonusRefusal(input: BonusRuleInput): string | null {
  const { planned, locked, wallet } = input
  if (!wallet || wallet.closed) return 'token wallet closed or gone'
  if (
    locked.brandId !== planned.brandId ||
    locked.planSlug !== planned.planSlug ||
    locked.providerSubscriptionId !== planned.providerSubscriptionId
  ) {
    return 'subscription changed between planning and the lock'
  }
  if (wallet.brandId !== locked.brandId) return 'token wallet of another brand'
  if (input.keyUsed) return 'already credited'
  // Any re-split of one signed notice keeps its checksum: a shifted cycle is the same charge.
  if (input.checksumSeen) return 'checksum of an already applied notice'
  if (input.lastCycle !== null && planned.cycleNumber <= input.lastCycle) {
    return `cycle ${planned.cycleNumber} not after the last bonified cycle ${input.lastCycle}`
  }
  return null
}
