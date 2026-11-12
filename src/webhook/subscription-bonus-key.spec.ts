import { subscriptionBonusKey } from './subscription-bonus-key'
import { subscriptionBonusLimits } from './subscription-bonus-limits'

const NAME = 'stores/s/subscription-plans/p/subscriptions/loc214'
const PROPS = ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'payment']

const paid = (data: Record<string, unknown> = {}, properties: unknown = PROPS): any => ({
  event: 'subscription.billingStatusChanged',
  data: { name: NAME, cycleNumber: 3, status: 'SUCCEEDED', payment: 'p-1', ...data },
  timestamp: 1768384800,
  signature: { properties, checksum: 'X' },
})

describe('subscriptionBonusKey', () => {
  const SUB = { id: 'row-1', providerSubscriptionId: NAME }

  it('is built from the subscription row, its Confio subscription and the cycle', () => {
    // R15: red if the key stops coming from the row or the cycle (event id, time, payment).
    expect(subscriptionBonusKey(paid(), SUB)).toBe(`subscription-bonus:row-1:${NAME}:ciclo-3`)
  })

  it('does not change with the data.name of the notice', () => {
    // R15: red if the key goes back to data.name: a re-split name would mint another key.
    expect(subscriptionBonusKey(paid({ name: `${NAME}9` }), SUB)).toBe(
      subscriptionBonusKey(paid(), SUB),
    )
  })

  it('differs for a new Confio subscription stored on the same row', () => {
    // R15: red if the Confio subscription leaves the key: a new signup's cycle 1 reads as credited.
    const renewed = { ...SUB, providerSubscriptionId: `${NAME}-2` }

    expect(subscriptionBonusKey(paid(), renewed)).not.toBe(subscriptionBonusKey(paid(), SUB))
  })

  it('is the same for another attempt and another delivery time of the same cycle', () => {
    // R15: red if the key takes the payment attempt or the timestamp of the notice.
    const later = { ...paid({ payment: 'p-2' }), timestamp: 1768999999 }

    expect(subscriptionBonusKey(later, SUB)).toBe(subscriptionBonusKey(paid(), SUB))
  })

  it('differs between two cycles of the same subscription', () => {
    // R15: red if the cycle number leaves the key: every later cycle reads as already credited.
    expect(subscriptionBonusKey(paid({ cycleNumber: 4 }), SUB)).not.toBe(
      subscriptionBonusKey(paid(), SUB),
    )
  })

  it.each([null, '', 'x'.repeat(257)])(
    'is null when the row holds Confio subscription %p',
    (name) => {
      // R15: red if a row without its Confio subscription still gets a key.
      expect(subscriptionBonusKey(paid(), { id: 'row-1', providerSubscriptionId: name })).toBeNull()
    },
  )

  it.each([
    ['name is not signed', paid({}, ['cycleNumber', 'status'])],
    ['cycleNumber is not signed', paid({}, ['name', 'status'])],
    ['properties is missing', paid({}, null)],
    ['cycleNumber is a string', paid({ cycleNumber: '3' })],
    ['cycleNumber is null', paid({ cycleNumber: null })],
    ['cycleNumber is fractional', paid({ cycleNumber: 1e-7 })],
    ['cycleNumber is negative', paid({ cycleNumber: -1 })],
  ])('is null when %s', (_name, payload) => {
    // R15: red if the signed-field or integer-cycle check is dropped from the key.
    expect(subscriptionBonusKey(payload, SUB)).toBeNull()
  })
})

describe('subscriptionBonusLimits', () => {
  const OLD_ENV = process.env
  afterEach(() => {
    process.env = OLD_ENV
  })

  it('reads both caps from the environment', () => {
    // R15: red if either cap stops reading its variable and keeps the default.
    process.env = {
      ...OLD_ENV,
      SUBSCRIPTION_BONUS_MAX_TOKENS: '700',
      SUBSCRIPTION_BONUS_MAX_TOKENS_PER_MONTH: '900',
    }

    expect(subscriptionBonusLimits()).toEqual({ perCredit: 700, perMonth: 900 })
  })

  it.each(['', '0', '-5', '1e-7', '2.5', 'abc', '99999999999999999999'])(
    'falls back to the defaults for %p',
    (raw) => {
      // R15: red if a malformed cap parses to NaN or 0, which would credit anything or nothing.
      process.env = {
        ...OLD_ENV,
        SUBSCRIPTION_BONUS_MAX_TOKENS: raw,
        SUBSCRIPTION_BONUS_MAX_TOKENS_PER_MONTH: raw,
      }

      expect(subscriptionBonusLimits()).toEqual({ perCredit: 10000, perMonth: 20000 })
    },
  )
})
