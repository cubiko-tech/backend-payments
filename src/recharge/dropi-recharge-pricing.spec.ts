import { exactTokens, rechargePesos, storedRate } from './dropi-recharge-pricing'

// Whole tokens at TRM `cents`, ceiled in integers: the reference the sweep holds.
const referencePesos = (tokens: number, cents: number) => {
  const hundredths = tokens * cents
  return Math.floor(hundredths / 100) + (hundredths % 100 > 0 ? 1 : 0)
}

describe('rechargePesos', () => {
  it('charges 10 tokens at TRM 4,000 as 40,000 pesos, VAT inside the price', () => {
    // R15: red when VAT is added on top again: it sees 47,600.
    expect(rechargePesos(10, 4000)).toBe(40_000)
  })

  it('rounds the pesos at TRM 4,000.37 up to the whole peso', () => {
    // R15: red when the ceiling becomes a rounding: 1 token, 4,000.37 pesos, gives 4,000.
    expect(rechargePesos(10, 4000.37)).toBe(40_004)
    expect(rechargePesos(10.5, 4000.37)).toBe(42_004)
    expect(rechargePesos(1, 4000.37)).toBe(4_001)
  })

  it('charges 375 tokens at TRM 4,113.60 as 1,542,600 pesos, not one more', () => {
    // R15: red when the price goes back to a float product with a ceiling: it gives 1,542,601.
    expect(rechargePesos(375, 4113.6)).toBe(1_542_600)
  })

  it('prices the largest recharges exactly, with a numerator past the safe integers', () => {
    // R15: red when the ceiling of the integer division goes: 999,999.99 tokens give 9,999,989,900.
    expect(rechargePesos(1_000_000, 10_000)).toBe(10_000_000_000)
    expect(rechargePesos(999_999.99, 9_999.99)).toBe(9_999_989_901)
  })

  it('prices with the TRM rounded to the two decimals the payment stores', () => {
    // R15: red when storedRate keeps the raw rate: it returns 4000.004.
    expect(storedRate(4000.004)).toBe(4000)
    expect(rechargePesos(1, 4000.004)).toBe(4_000)
  })

  it('matches the integer account for 1 to 1,000 tokens at TRM 3,800 to 4,200', () => {
    // R15: red when the price goes back to a float product: 375 tokens at 4,113.60 differ.
    const misses: string[] = []
    // Step 49 cents: it walks through 4,113.60, the TRM the float product overcharges at.
    for (let cents = 380_000; cents <= 420_000; cents += 49) {
      for (let tokens = 1; tokens <= 1_000; tokens++) {
        if (rechargePesos(tokens, cents / 100) !== referencePesos(tokens, cents)) {
          misses.push(`${tokens}@${cents}`)
        }
      }
    }
    expect(misses).toEqual([])
  })
})

describe('exactTokens', () => {
  it('drops the noise below the hundredth and keeps two decimals', () => {
    // R15: red when it returns the raw number: it sees 10.000000001.
    expect(exactTokens(10.000000001)).toBe(10)
    expect(exactTokens(0.1 + 0.2)).toBe(0.3)
    expect(exactTokens(10.5)).toBe(10.5)
  })
})
