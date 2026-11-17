export interface TaxInclusiveBreakdown {
  subtotal: number
  taxAmount: number
  totalAmount: number
}

/**
 * Splits a final, tax-inclusive total: `subtotal = round(total / (1 + rate))` and
 * `taxAmount = round(total - subtotal)`, to the cent, so the two always add up to the total.
 * A rate that is not above 0 leaves the whole total as subtotal.
 */
export function breakDownTaxInclusiveAmount(
  totalAmount: number,
  taxRate: number,
): TaxInclusiveBreakdown {
  const normalizedTotal = Math.round(Number(totalAmount) * 100) / 100
  const normalizedRate = Number(taxRate)
  if (!Number.isFinite(normalizedRate) || normalizedRate <= 0) {
    return { subtotal: normalizedTotal, taxAmount: 0, totalAmount: normalizedTotal }
  }
  const subtotal = Math.round((normalizedTotal / (1 + normalizedRate)) * 100) / 100
  const taxAmount = Math.round((normalizedTotal - subtotal) * 100) / 100
  return { subtotal, taxAmount, totalAmount: normalizedTotal }
}
