import { PaymentStatus } from '../payment/entities/payment.entity'
import { DropiChargeResult, decideRechargeResult } from './dropi-recharge-result'

const charged = (dropiOperationId = 'op-1') => ({
  status: DropiChargeResult.CHARGED,
  dropiOperationId,
})
const failed = { status: DropiChargeResult.FAILED }

describe('decideRechargeResult', () => {
  it('applies a charged or failed report to a pending recharge', () => {
    // R15: red when pending stops being the only state that applies: either report is not applied.
    const pending = { status: PaymentStatus.PENDING }
    expect(decideRechargeResult(pending, charged())).toBe('apply')
    expect(decideRechargeResult(pending, failed)).toBe('apply')
  })

  it('replays the same charged report on a completed recharge', () => {
    // R15: red when the operation id comparison is inverted: the same charge is a conflict.
    const completed = { status: PaymentStatus.COMPLETED, dropiOperationId: 'op-1' }
    expect(decideRechargeResult(completed, charged('op-1'))).toBe('replay')
  })

  it('refuses a charged report with another operation id on a completed recharge', () => {
    // R15: red when a completed recharge replays any charge: the other operation id is let through.
    const completed = { status: PaymentStatus.COMPLETED, dropiOperationId: 'op-1' }
    expect(decideRechargeResult(completed, charged('op-2'))).toBe('conflict')
  })

  it('refuses a failed report on a completed recharge', () => {
    // R15: red when any failed report on a closed recharge replays: the completed one answers 200.
    const completed = { status: PaymentStatus.COMPLETED, dropiOperationId: 'op-1' }
    expect(decideRechargeResult(completed, failed)).toBe('conflict')
  })

  it('replays a failed report on a failed recharge', () => {
    // R15: red when a failed recharge refuses every report: the repeated failure gets 409.
    expect(decideRechargeResult({ status: PaymentStatus.FAILED }, failed)).toBe('replay')
  })

  it('refuses a charged report on a failed recharge', () => {
    // R15: red when a failed recharge accepts a charge: it would be credited after closing.
    const closed = { status: PaymentStatus.FAILED, dropiOperationId: 'op-1' }
    expect(decideRechargeResult(closed, charged('op-1'))).toBe('conflict')
  })

  it.each([PaymentStatus.PROCESSING, PaymentStatus.REFUNDED, PaymentStatus.DISPUTED])(
    'refuses any report on a %s recharge',
    (status) => {
      // R15: red when only completed and failed count as closed: a refunded one gets applied.
      expect(decideRechargeResult({ status }, charged())).toBe('conflict')
      expect(decideRechargeResult({ status }, failed)).toBe('conflict')
    },
  )
})
