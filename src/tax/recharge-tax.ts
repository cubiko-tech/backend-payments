import { HttpStatus, Logger } from '@nestjs/common'

import { RequestException } from '../shared/exception/request.exception'
import { isVatCountry, TaxService } from './tax.service'

export interface RechargeTax {
  taxName: string
  taxRate: number
  isInclusive: boolean
}

/**
 * The tax of a recharge for `country`. 422 `TAX_RATE_UNAVAILABLE` when it cannot be read, or when
 * a VAT country has no rate above 0: a recharge is never charged without its VAT.
 */
export async function resolveRechargeTax(
  taxService: TaxService,
  country: string,
  log: Logger,
): Promise<RechargeTax> {
  const normalizedCountry = String(country || '')
    .trim()
    .toUpperCase()
  let tax: RechargeTax | null = null
  try {
    tax = await taxService.getTaxForCountry(country)
  } catch (error) {
    log.error(
      `Unable to read tax rate for country ${normalizedCountry || country}: ${error.message}`,
    )
    throw taxRateUnavailable(`Unable to read tax rate for country ${normalizedCountry || country}`)
  }
  return validateRechargeTax(country, tax, log)
}

/** Validation half of `resolveRechargeTax`, for a tax already read. */
export function validateRechargeTax(
  country: string,
  tax: RechargeTax | null | undefined,
  log: Logger,
): RechargeTax {
  const normalizedCountry = String(country || '')
    .trim()
    .toUpperCase()
  const parsedRate =
    tax && tax.taxRate !== null && tax.taxRate !== undefined ? Number(tax.taxRate) : NaN
  const normalizedTaxName = String(tax?.taxName || '').trim()
  const requiresVat = isVatCountry(normalizedCountry) || normalizedTaxName.toUpperCase() === 'IVA'
  const isUnreadable =
    !tax ||
    !Number.isFinite(parsedRate) ||
    parsedRate < 0 ||
    (requiresVat && (normalizedTaxName === 'N/A' || parsedRate <= 0))

  if (isUnreadable) {
    log.error(`Unable to read a valid tax rate for country ${normalizedCountry || country}`)
    throw taxRateUnavailable(
      `Unable to read a valid tax rate for country ${normalizedCountry || country}`,
    )
  }

  return { taxName: normalizedTaxName || 'N/A', taxRate: parsedRate, isInclusive: true }
}

function taxRateUnavailable(message: string): RequestException {
  return new RequestException(
    { code: 'TAX_RATE_UNAVAILABLE', message },
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
}
