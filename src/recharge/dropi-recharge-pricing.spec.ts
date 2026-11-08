import { exactTokens, rechargePesos, storedRate } from './dropi-recharge-pricing'

// Whole tokens at TRM `cents` with the 19 % VAT, ceiled in integers: the reference the sweep holds.
const referencePesos = (tokens: number, cents: number) => {
  const tenThousandths = tokens * cents * 119
  return Math.floor(tenThousandths / 10_000) + (tenThousandths % 10_000 > 0 ? 1 : 0)
}

describe('rechargePesos', () => {
  it('charges 10 tokens at TRM 4,000 with the 19 % VAT of Colombia as 47,600 pesos', () => {
    // R15: red when the (1 + tax) factor goes: it sees 40,000.
    expect(rechargePesos(10, 4000, 0.19)).toBe(47_600)
  })

  it('rounds the pesos at TRM 4,000.37 up to the whole peso', () => {
    // R15: red when the ceiling becomes a rounding: 1 token, 4,760.44 pesos, gives 4,760.
    expect(rechargePesos(10, 4000.37, 0.19)).toBe(47_605)
    expect(rechargePesos(10.5, 4000.37, 0.19)).toBe(49_985)
    expect(rechargePesos(1, 4000.37, 0.19)).toBe(4_761)
  })

  it('charges 375 tokens at TRM 4,113.60 as 1,835,694 pesos, not one more', () => {
    // R15: red when the price goes back to a float product: it gives 1,835,695.
    expect(rechargePesos(375, 4113.6, 0.19)).toBe(1_835_694)
  })

  it('prices the largest recharges exactly, with a numerator past the safe integers', () => {
    // R15: red when the ceiling of the integer division goes: 999,999.99 tokens give 11,899,987,981.
    expect(rechargePesos(1_000_000, 10_000, 0.19)).toBe(11_900_000_000)
    expect(rechargePesos(999_999.99, 9_999.99, 0.19)).toBe(11_899_987_982)
  })

  it('prices with the TRM rounded to the two decimals the payment stores', () => {
    // R15: red when the raw rate is used: 1 token at 4000.004 with no tax gives 4,001.
    expect(storedRate(4000.004)).toBe(4000)
    expect(rechargePesos(1, 4000.004, 0)).toBe(4_000)
  })

  it('matches the integer account for 1 to 1,000 tokens at TRM 3,800 to 4,200', () => {
    // R15: red when the price goes back to a float product: 375 tokens at 4,113.60 differ.
    const misses: string[] = []
    // Step 49 cents: it walks through 4,113.60, the TRM the float product overcharges at.
    for (let cents = 380_000; cents <= 420_000; cents += 49) {
      for (let tokens = 1; tokens <= 1_000; tokens++) {
        if (rechargePesos(tokens, cents / 100, 0.19) !== referencePesos(tokens, cents)) {
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
