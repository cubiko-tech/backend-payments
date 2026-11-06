/**
 * Bounds for every amount an admin types: money and token columns are numeric(15,2), so an amount
 * has at most two decimals and stays well under the column maximum, leaving room for the sums.
 */
export const MAX_MONEY_AMOUNT = 1_000_000_000_000

export const MONEY_INPUT = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }
