import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { RequestException } from '../shared/exception/request.exception'

export const TRM_SOURCE_URL = 'TRM_SOURCE_URL'
export const DEFAULT_TRM_SOURCE_URL = 'https://www.datos.gov.co/resource/ceyp-9c7c.json'

const CACHE_TTL_MS = 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5000

export interface UsdCopRate {
  /** COP per 1 USD, as published by the source. */
  rate: number
  /** Day the rate is valid from, `YYYY-MM-DD`. */
  date: string
}

/**
 * USD→COP exchange rate (TRM) from the public datos.gov.co dataset, cached in memory for one
 * hour per instance. There is no fallback rate: with the source down and no fresh cache it
 * throws 503 `EXCHANGE_RATE_UNAVAILABLE`, and a failure is never cached.
 */
@Injectable()
export class TrmService {
  private readonly log = new Logger(TrmService.name)
  private cached?: { value: UsdCopRate; expiresAt: number }
  private inFlight?: Promise<UsdCopRate>

  constructor(
    @Optional() @Inject(TRM_SOURCE_URL) private readonly sourceUrl: string = DEFAULT_TRM_SOURCE_URL,
  ) {}

  async getUsdCopRate(): Promise<UsdCopRate> {
    if (this.cached && Date.now() < this.cached.expiresAt) {
      return this.cached.value
    }
    // Concurrent callers share one request to the source.
    if (!this.inFlight) {
      this.inFlight = this.fetchRate().finally(() => {
        this.inFlight = undefined
      })
    }
    return this.inFlight
  }

  private async fetchRate(): Promise<UsdCopRate> {
    const url = `${this.sourceUrl}?$order=vigenciadesde%20DESC&$limit=1`
    let rows: unknown
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      rows = await response.json()
    } catch (error) {
      this.log.error(`TRM source unavailable: ${(error as Error).message}`)
      throw exchangeRateUnavailable()
    }
    const row = Array.isArray(rows) ? rows[0] : undefined
    const rate = Number(row?.valor)
    const since = typeof row?.vigenciadesde === 'string' ? row.vigenciadesde : ''
    // The source sends the date without a zone; slicing avoids a timezone shifting the day.
    const date = since.slice(0, 10)
    if (!Number.isFinite(rate) || rate <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      this.log.error(`TRM source returned an unreadable row: ${JSON.stringify(row ?? null)}`)
      throw exchangeRateUnavailable()
    }
    const value = { rate, date }
    this.cached = { value, expiresAt: Date.now() + CACHE_TTL_MS }
    return value
  }
}

/** 503 `EXCHANGE_RATE_UNAVAILABLE`: no rate to charge with, so the payment is not created. */
export function exchangeRateUnavailable(): RequestException {
  return new RequestException(
    { code: 'EXCHANGE_RATE_UNAVAILABLE', message: 'No TRM is available to charge this payment' },
    HttpStatus.SERVICE_UNAVAILABLE,
  )
}
