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
  it('is built from the subscription and the cycle of the notice, with its own prefix', () => {
    // R15: red if the key stops coming from the cycle (provider event id, time, payment).
    expect(subscriptionBonusKey(paid())).toBe(`subscription-bonus:${NAME}:ciclo-3`)
  })

  it('is the same for another attempt and another delivery time of the same cycle', () => {
    // R15: red if the key takes the payment attempt or the timestamp of the notice.
    const later = { ...paid({ payment: 'p-2' }), timestamp: 1768999999 }

    expect(subscriptionBonusKey(later)).toBe(subscriptionBonusKey(paid()))
  })

  it('differs between two cycles of the same subscription', () => {
    // R15: red if the cycle number leaves the key: every later cycle reads as already credited.
    expect(subscriptionBonusKey(paid({ cycleNumber: 4 }))).not.toBe(subscriptionBonusKey(paid()))
  })

  it.each([
    ['name is not signed', paid({}, ['cycleNumber', 'status'])],
    ['cycleNumber is not signed', paid({}, ['name', 'status'])],
    ['properties is missing', paid({}, null)],
    ['name is missing', paid({ name: undefined })],
    ['name is too long', paid({ name: 'x'.repeat(257) })],
    ['cycleNumber is a string', paid({ cycleNumber: '3' })],
    ['cycleNumber is null', paid({ cycleNumber: null })],
    ['cycleNumber is fractional', paid({ cycleNumber: 1e-7 })],
    ['cycleNumber is negative', paid({ cycleNumber: -1 })],
  ])('is null when %s', (_name, payload) => {
    expect(subscriptionBonusKey(payload)).toBeNull()
  })
})

describe('subscriptionBonusLimits', () => {
  const OLD_ENV = process.env
  afterEach(() => {
    process.env = OLD_ENV
  })

  it('reads both caps from the environment', () => {
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
