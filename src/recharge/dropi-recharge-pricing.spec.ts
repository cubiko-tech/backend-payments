import { rechargePesos, storedRate } from './dropi-recharge-pricing'

describe('rechargePesos', () => {
  it('charges 10 tokens at TRM 4,000 with the 19 % VAT of Colombia as 47,600 pesos', () => {
    // R15: red when the (1 + tax) factor goes: it sees 40,000.
    expect(rechargePesos(10, 4000, 0.19)).toBe(47_600)
  })

  it('rounds the pesos at TRM 4,000.37 up to the whole peso', () => {
    // R15: red when the ceiling becomes a rounding: 1 token, 4,760.44 pesos, gives 4,760.
    expect(rechargePesos(10.5, 4000.37, 0.19)).toBe(49_985)
    expect(rechargePesos(1, 4000.37, 0.19)).toBe(4_761)
  })

  it('prices with the TRM rounded to the two decimals the payment stores', () => {
    // R15: red when the raw rate is used: 1 token at 4000.004 with no tax gives 4,001.
    expect(storedRate(4000.004)).toBe(4000)
    expect(rechargePesos(1, 4000.004, 0)).toBe(4_000)
  })
})
