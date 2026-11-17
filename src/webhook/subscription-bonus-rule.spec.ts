import { BonusRuleInput, bonusRefusal } from './subscription-bonus-rule'

const SUB = { brandId: 'brand-a', planSlug: 'pro-500', providerSubscriptionId: 'confio/s-1' }

/** A bonus that may be credited; each case changes only what makes it different. */
const input = (over: Partial<BonusRuleInput> = {}): BonusRuleInput => ({
  planned: { ...SUB, cycleNumber: 2 },
  locked: { ...SUB },
  wallet: { brandId: 'brand-a', closed: false },
  keyUsed: false,
  checksumSeen: false,
  lastCycle: 1,
  ...over,
})

describe('bonusRefusal', () => {
  it('lets a new cycle of an unchanged subscription be credited', () => {
    // R15: red if any row of the table refuses the plain next cycle.
    expect(bonusRefusal(input())).toBeNull()
  })

  it('lets the first cycle be credited when nothing was bonified yet', () => {
    // R15: red if a missing last cycle is read as 0 or as a refusal.
    expect(bonusRefusal(input({ planned: { ...SUB, cycleNumber: 0 }, lastCycle: null }))).toBeNull()
  })

  it.each([null, { brandId: 'brand-a', closed: true }])('refuses wallet %p', (wallet) => {
    // R15: red if a closed or missing token wallet is credited.
    expect(bonusRefusal(input({ wallet }))).toMatch(/wallet closed or gone/)
  })

  it.each([
    ['brand', { ...SUB, brandId: 'brand-b' }],
    ['plan', { ...SUB, planSlug: 'pro-700' }],
    ['Confio subscription', { ...SUB, providerSubscriptionId: 'confio/s-2' }],
  ])('refuses when the locked row changed its %s', (_field, locked) => {
    // R15: red if brand, plan or Confio subscription stop being compared with the locked row.
    expect(
      bonusRefusal(input({ locked, wallet: { brandId: locked.brandId, closed: false } })),
    ).toMatch(/subscription changed/)
  })

  it('refuses a token wallet of another brand', () => {
    // R15: red if the wallet brand is not compared with the locked row.
    expect(bonusRefusal(input({ wallet: { brandId: 'brand-b', closed: false } }))).toMatch(
      /another brand/,
    )
  })

  it('refuses a key already used', () => {
    // R15: red if the key stops guarding a credited cycle.
    expect(bonusRefusal(input({ keyUsed: true }))).toMatch(/already credited/)
  })

  it('refuses the checksum of an applied notice, even for a higher cycle', () => {
    // R15: red if the checksum row is dropped: the shifted cycle 11 credits again.
    expect(
      bonusRefusal(input({ planned: { ...SUB, cycleNumber: 11 }, checksumSeen: true })),
    ).toMatch(/checksum/)
  })

  it.each([1, 0])('refuses cycle %p when cycle 1 was the last bonified', (cycleNumber) => {
    // R15: red if the comparison becomes < or the last cycle is ignored.
    expect(bonusRefusal(input({ planned: { ...SUB, cycleNumber } }))).toMatch(/not after/)
  })

  it('credits a skipped cycle once it is after the last bonified', () => {
    // R15: red if the rule demands exactly last + 1.
    expect(bonusRefusal(input({ planned: { ...SUB, cycleNumber: 5 } }))).toBeNull()
  })
})
