const DEFAULT_CHECKOUT_EXPIRY_HOURS = 24

/**
 * Hours a checkout stays valid, from `CHECKOUT_EXPIRY_HOURS`. The only reader of that variable.
 * An invalid value falls back to the default: a NaN would silently turn expiry off.
 */
export function checkoutExpiryHours(): number {
  const hours = parseInt(process.env.CHECKOUT_EXPIRY_HOURS ?? '', 10)
  return hours > 0 ? hours : DEFAULT_CHECKOUT_EXPIRY_HOURS
}
