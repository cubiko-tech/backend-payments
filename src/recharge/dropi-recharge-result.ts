import { PaymentStatus } from '../payment/entities/payment.entity'

/** What ROAX Ads reports of the charge it made in dropi-wallet. */
export enum DropiChargeResult {
  CHARGED = 'charged',
  FAILED = 'failed',
}

/** `apply` closes the pending recharge, `replay` answers it as it is, `conflict` refuses with 409. */
export type RechargeResultDecision = 'apply' | 'replay' | 'conflict'

export interface StoredRecharge {
  status: PaymentStatus
  dropiOperationId?: string | null
}

export interface ReportedResult {
  status: DropiChargeResult
  dropiOperationId?: string
}

/**
 * Decides what a reported result does to a recharge. Only a `pending` one is closed; the same
 * report on a closed one is a replay, and any other report on a closed one is a conflict.
 */
export function decideRechargeResult(
  stored: StoredRecharge,
  reported: ReportedResult,
): RechargeResultDecision {
  if (stored.status === PaymentStatus.PENDING) return 'apply'
  if (reported.status === DropiChargeResult.CHARGED) {
    const sameCharge = stored.dropiOperationId === reported.dropiOperationId
    return stored.status === PaymentStatus.COMPLETED && sameCharge ? 'replay' : 'conflict'
  }
  return stored.status === PaymentStatus.FAILED ? 'replay' : 'conflict'
}
