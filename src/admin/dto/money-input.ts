import { ValidateBy, ValidationOptions } from 'class-validator'

/**
 * Bounds for every amount an admin types: money and token columns are numeric(15,2), so an amount
 * has at most two decimals and stays well under the column maximum, leaving room for the sums.
 */
export const MAX_MONEY_AMOUNT = 1_000_000_000_000

export const MONEY_INPUT = { allowNaN: false, allowInfinity: false }

/**
 * Accepts a number with at most two decimals. Use it instead of class-validator `maxDecimalPlaces`,
 * which splits `toString()` on the dot and throws on exponent forms like `1e-7` (500, not 400).
 */
export function HasAtMostTwoDecimals(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'hasAtMostTwoDecimals',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'number' && Number(value.toFixed(2)) === value,
        defaultMessage: () => '$property must have at most two decimals',
      },
    },
    options,
  )
}
