import { Payment } from '../payment/entities/payment.entity'
import { checkoutExpiryHours } from './checkout-expiry'
import { isRetryWindowOpen } from './checkout-idempotency'

const HOUR_MS = 60 * 60 * 1000
const NOW = new Date('2026-06-15T12:00:00.000Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS)
const payment = (fields: Partial<Payment>) => fields as Payment

describe('checkout expiry', () => {
  const original = process.env.CHECKOUT_EXPIRY_HOURS

  afterEach(() => {
    if (original === undefined) delete process.env.CHECKOUT_EXPIRY_HOURS
    else process.env.CHECKOUT_EXPIRY_HOURS = original
  })

  it.each([
    ['unset', undefined, 24],
    ['not a number', 'soon', 24],
    ['zero', '0', 24],
    ['negative', '-3', 24],
    ['a valid value', '48', 48],
  ])('reads CHECKOUT_EXPIRY_HOURS when %s', (_name, value, expected) => {
    // R15 (Mutation): dropping the `hours > 0` fallback turns the invalid values red.
    if (value === undefined) delete process.env.CHECKOUT_EXPIRY_HOURS
    else process.env.CHECKOUT_EXPIRY_HOURS = value
    expect(checkoutExpiryHours()).toBe(expected)
  })

  it('keeps the retry window open up to exactly the expiry and closes it right after', () => {
    // R15 (Mutation): changing `<=` to `<` in isRetryWindowOpen turns the exact limit red.
    process.env.CHECKOUT_EXPIRY_HOURS = '24'
    expect(isRetryWindowOpen(payment({ createdAt: hoursAgo(24) }), NOW)).toBe(true)
    expect(isRetryWindowOpen(payment({ createdAt: hoursAgo(24.01) }), NOW)).toBe(false)
  })

  it('moves the retry window with CHECKOUT_EXPIRY_HOURS', () => {
    // R15 (Mutation): hardcoding 24 hours in isRetryWindowOpen turns this red.
    process.env.CHECKOUT_EXPIRY_HOURS = '48'
    expect(isRetryWindowOpen(payment({ createdAt: hoursAgo(30) }), NOW)).toBe(true)
  })

  it('measures the window from the first attempt when the retry moved createdAt', () => {
    // R15 (Mutation): measuring only createdAt in paymentBirth turns this red.
    process.env.CHECKOUT_EXPIRY_HOURS = '24'
    const retried = payment({
      createdAt: hoursAgo(1),
      metadata: { firstAttemptAt: hoursAgo(25).toISOString() },
    })
    expect(isRetryWindowOpen(retried, NOW)).toBe(false)
  })

  it('closes the window when the birth cannot be read', () => {
    // R15 (Mutation): returning `!(elapsedMs > limit)` in isRetryWindowOpen turns this red.
    process.env.CHECKOUT_EXPIRY_HOURS = '24'
    const unreadable = payment({ metadata: { firstAttemptAt: 'not-a-date' } })
    expect(isRetryWindowOpen(unreadable, NOW)).toBe(false)
  })
})
