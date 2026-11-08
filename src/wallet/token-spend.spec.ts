import { planTokenRefund, planTokenSpend } from './token-spend'

describe('planTokenSpend (token debit order, LOC-132)', () => {
  it('spends gift before purchased: 5 gift and 10 purchased, a debit of 5 takes the gift', () => {
    // R15: red when purchased goes before gift: the plan takes 5 purchased and leaves the gift.
    const taken = planTokenSpend({ gift: 500, purchased: 1000, dropi: 0 }, 500, false)

    expect(taken).toEqual({ gift: 500, purchased: 0, dropi: 0 })
  })

  it('refuses outside Dropi when only Dropi tokens would cover it, and takes nothing from Dropi', () => {
    // R15: red when Dropi tokens count as spendable outside Dropi: the plan takes 2 gift and 2 Dropi.
    const taken = planTokenSpend({ gift: 200, purchased: 0, dropi: 300 }, 400, false)

    expect(taken).toBeNull()
  })

  it('inside Dropi spends gift, then purchased, then Dropi tokens', () => {
    // R15: red when inside Dropi the Dropi tokens go first: the plan takes 300 Dropi and 100 gift.
    const taken = planTokenSpend({ gift: 100, purchased: 100, dropi: 300 }, 400, true)

    expect(taken).toEqual({ gift: 100, purchased: 100, dropi: 200 })
  })

  it('refuses inside Dropi when all origins together do not cover it', () => {
    // R15: red when a 1-cent shortfall is tolerated: the plan takes all 300 for a debit of 301.
    expect(planTokenSpend({ gift: 100, purchased: 100, dropi: 100 }, 301, true)).toBeNull()
  })
})

describe('planTokenRefund (refund order of a debit, LOC-187)', () => {
  it('gives 3 of a gift 4 and purchased 4 debit back to purchased, gift untouched', () => {
    // R15: red when the refund follows the spend order: it gives 3 to gift.
    const given = planTokenRefund({ gift: 400, purchased: 400, dropi: 0 }, 300)

    expect(given).toEqual({ gift: 0, purchased: 300, dropi: 0 })
  })

  it('gives Dropi back first, then purchased, then gift, each up to what it still owes', () => {
    // R15: red when an origin takes past what it owes: Dropi gets all 450.
    const given = planTokenRefund({ gift: 200, purchased: 100, dropi: 200 }, 450)

    expect(given).toEqual({ gift: 150, purchased: 100, dropi: 200 })
  })

  it('refuses a refund past what the debit still owes', () => {
    // R15: red when a 1-cent excess is tolerated: the plan gives back 501 of 500.
    expect(planTokenRefund({ gift: 100, purchased: 400, dropi: 0 }, 501)).toBeNull()
  })
})
