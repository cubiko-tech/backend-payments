import { planTokenSpend } from './token-spend'

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
    const taken = planTokenSpend({ gift: 100, purchased: 100, dropi: 300 }, 400, true)

    expect(taken).toEqual({ gift: 100, purchased: 100, dropi: 200 })
  })

  it('refuses inside Dropi when all origins together do not cover it', () => {
    expect(planTokenSpend({ gift: 100, purchased: 100, dropi: 100 }, 301, true)).toBeNull()
  })
})
