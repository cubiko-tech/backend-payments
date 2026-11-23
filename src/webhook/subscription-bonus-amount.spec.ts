import { Logger } from '@nestjs/common'

import { SubscriptionBonusService } from './subscription-bonus.service'

const NAME = 'stores/s/subscription-plans/p/subscriptions/amount'
const PROPS = ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'payment']

const paid = (amountCents: unknown, properties = PROPS) => ({
  event: 'subscription.billingStatusChanged',
  data: { name: NAME, cycleNumber: 2, amountCents, currencyCode: 'COP', status: 'SUCCEEDED' },
  timestamp: 1768384800,
  signature: { properties, checksum: 'AB12' },
})

const sub: any = {
  id: '33333333-3333-4333-8333-333333333333',
  brandId: 'brand-amount',
  userId: 'user-amount',
  planSlug: 'pro-500',
  providerSubscriptionId: NAME,
}

/** The cycle bonus only comes from a cycle that charged something (LOC-272). */
describe('SubscriptionBonusService.plan — the charged amount', () => {
  let roles: { getTokensPerCycle: jest.Mock }
  let wallets: { getOrCreate: jest.Mock }
  let service: SubscriptionBonusService
  let log: jest.SpyInstance

  beforeEach(() => {
    // R17: the plan catalog (backend-roles) and the wallet are other units; `plan` only reads them.
    roles = { getTokensPerCycle: jest.fn().mockResolvedValue(500) }
    wallets = { getOrCreate: jest.fn().mockResolvedValue({ id: 'wallet-1' }) }
    service = new SubscriptionBonusService(wallets as any, {} as any, roles as any)
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => jest.restoreAllMocks())

  it('scenario 4: a cycle charged 0 gives no bonus and logs why', async () => {
    // R15: red if `plan` stops reading `amountCents`: a bonus is planned for 0.
    expect(await service.plan(paid(0) as any, sub)).toBeNull()

    expect(wallets.getOrCreate).not.toHaveBeenCalled()
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      `Cycle bonus skipped for ${sub.id}: cycle 2 charged 0`,
    )
  })

  it.each([[undefined], [null], ['1990000'], [1e-7], [-100], [Number.NaN]])(
    'gives no bonus for the amount %p',
    async (amount) => {
      // R15: red if `plan` stops reading `amountCents`: each of these plans a bonus.
      expect(await service.plan(paid(amount) as any, sub)).toBeNull()
    },
  )

  it('gives no bonus when the amount is not signed', async () => {
    // R15: red if the amount is read without checking `signature.properties`.
    const unsigned = PROPS.filter((p) => p !== 'amountCents')
    expect(await service.plan(paid(1990000, unsigned) as any, sub)).toBeNull()
  })

  it('plans the bonus of a cycle that charged something', async () => {
    // R15: red if `plan` refuses every amount: a paid cycle gets no bonus.
    const bonus = await service.plan(paid(1990000) as any, sub)

    expect(bonus).toEqual(
      expect.objectContaining({ tokens: 500, walletId: 'wallet-1', cycleNumber: 2 }),
    )
  })
})
