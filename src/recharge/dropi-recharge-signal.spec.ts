import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { ApmAgent } from '../shared/apm/apm-agent'
import { DropiRechargeSignal } from './dropi-recharge-signal'

const NOW = new Date('2026-11-07T12:00:00Z')

const rechargeOf = (status: PaymentStatus, overrides: Partial<Payment> = {}) =>
  ({
    id: 'recharge-1',
    status,
    amount: '41650.00',
    createdAt: new Date(NOW.getTime() - 75_000),
    userId: 'user-1',
    metadata: { dropiRecharge: { tokens: 10, tokenPriceUsd: 1, bonusTokens: 0 } },
    ...overrides,
  }) as unknown as Payment

describe('DropiRechargeSignal', () => {
  // R17: New Relic is an external service with a cost; the spy keeps what the agent would send.
  const agent = { recordCustomEvent: jest.fn() } satisfies ApmAgent
  const signal = new DropiRechargeSignal(agent)

  beforeEach(() => agent.recordCustomEvent.mockReset())

  it.each([
    [PaymentStatus.PENDING, 'pending'],
    [PaymentStatus.COMPLETED, 'charged'],
    [PaymentStatus.FAILED, 'failed'],
  ])('a %s recharge is recorded as %s with its tokens, pesos and age', (status, named) => {
    // R15: red when the status map goes: completed is sent as completed, not charged.
    signal.changed(rechargeOf(status), NOW)

    expect(agent.recordCustomEvent).toHaveBeenCalledWith('DropiRecharge', {
      rechargeId: 'recharge-1',
      status: named,
      tokens: 10,
      amountCop: 41650,
      ageSeconds: 75,
    })
  })

  it('a recharge born after the app clock is recorded with age 0, never negative', () => {
    // R15: red when secondsSince drops its floor at 0: the age is sent as -30.
    const ahead = new Date(NOW.getTime() + 30_000)
    signal.changed(rechargeOf(PaymentStatus.PENDING, { createdAt: ahead }), NOW)

    expect(agent.recordCustomEvent).toHaveBeenCalledWith(
      'DropiRecharge',
      expect.objectContaining({ ageSeconds: 0 }),
    )
  })

  it('the backlog is recorded as its own event', () => {
    // R15: red when backlog reuses the recharge event type: the alert query would not find it.
    signal.backlog(2, 2400)

    expect(agent.recordCustomEvent).toHaveBeenCalledWith('DropiRechargeBacklog', {
      pending: 2,
      oldestPendingSeconds: 2400,
    })
  })

  it('an agent that throws, or a recharge it cannot read, never reaches the caller', () => {
    // R15: red when record drops its try: the agent error escapes changed().
    agent.recordCustomEvent.mockImplementation(() => {
      throw new Error('agent down')
    })

    expect(() => signal.changed(rechargeOf(PaymentStatus.COMPLETED), NOW)).not.toThrow()
    expect(() => signal.changed(rechargeOf(PaymentStatus.PENDING, { metadata: {} }))).not.toThrow()
  })
})
