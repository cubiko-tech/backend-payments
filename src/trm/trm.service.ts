import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { RequestException } from '../shared/exception/request.exception'
import { withinMs } from '../wallet/movement-limits'

export const TRM_SOURCE_URL = 'TRM_SOURCE_URL'
export const DEFAULT_TRM_SOURCE_URL = 'https://www.datos.gov.co/resource/ceyp-9c7c.json'

const CACHE_TTL_MS = 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 5000
/** COP per USD outside this range is a source error, never a price. */
export const MIN_CREDIBLE_RATE = 2000
export const MAX_CREDIBLE_RATE = 10000
// Colombia keeps UTC-5 all year: the TRM day is the day in Bogota.
const BOGOTA_OFFSET_MS = -5 * 60 * 60 * 1000

export interface UsdCopRate {
  /** COP per 1 USD, as published by the source. */
  rate: number
  /** Day the rate is valid from, `YYYY-MM-DD`. */
  date: string
}

interface TrmRow {
  valor?: unknown
  vigenciadesde?: unknown
  vigenciahasta?: unknown
}

/** `YYYY-MM-DD` of `epochMs` in Bogota. */
export function bogotaDay(epochMs: number): string {
  return new Date(epochMs + BOGOTA_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * USD→COP exchange rate (TRM) in force today, from the public datos.gov.co dataset, cached in
 * memory for one hour per instance and never past the last day of its validity. There is no
 * fallback rate: with no row in force, a rate outside [MIN_CREDIBLE_RATE, MAX_CREDIBLE_RATE] or
 * the source down, it throws 503 `EXCHANGE_RATE_UNAVAILABLE`, and a failure is never cached.
 */
@Injectable()
export class TrmService {
  private readonly log = new Logger(TrmService.name)
  private cached?: { value: UsdCopRate; until: string; expiresAt: number }
  private inFlight?: Promise<{ value: UsdCopRate; until: string }>

  constructor(
    @Optional() @Inject(TRM_SOURCE_URL) private readonly sourceUrl: string = DEFAULT_TRM_SOURCE_URL,
  ) {}

  /**
   * The rate in force on the caller's day in Bogota, taken when it calls. With `timeoutMs`, this
   * caller stops waiting after it with a 503; the query itself keeps its own timeout and still
   * fills the cache for the next caller.
   */
  async getUsdCopRate(timeoutMs?: number): Promise<UsdCopRate> {
    const now = Date.now()
    const today = bogotaDay(now)
    const cached = this.cached
    if (cached && now < cached.expiresAt && today <= cached.until) {
      return cached.value
    }
    // Concurrent callers share one request to the source.
    if (!this.inFlight) {
      this.inFlight = this.fetchRate().finally(() => {
        this.inFlight = undefined
      })
    }
    const quote = await (timeoutMs ? this.within(this.inFlight, timeoutMs) : this.inFlight)
    // A query started before midnight may bring a row that ended yesterday for this caller.
    if (today > quote.until) {
      this.log.error(`TRM row in force until ${quote.until} is no longer valid on ${today}`)
      throw exchangeRateUnavailable()
    }
    return quote.value
  }

  private within<T>(query: Promise<T>, timeoutMs: number): Promise<T> {
    return withinMs(query, timeoutMs).catch((error) => {
      if (error instanceof RequestException) throw error
      this.log.error(`TRM source did not answer within ${timeoutMs} ms`)
      throw exchangeRateUnavailable()
    })
  }

  /** The rate in force on `day` (`YYYY-MM-DD` in Bogota), straight from the source and never cached. */
  async rateOn(day: string): Promise<UsdCopRate> {
    return (await this.queryInForce(day)).value
  }

  private async fetchRate(): Promise<{ value: UsdCopRate; until: string }> {
    const quote = await this.queryInForce(bogotaDay(Date.now()))
    this.cached = { ...quote, expiresAt: Date.now() + CACHE_TTL_MS }
    return quote
  }

  private async queryInForce(today: string): Promise<{ value: UsdCopRate; until: string }> {
    const inForce = `vigenciadesde <= '${today}T00:00:00' AND vigenciahasta >= '${today}T00:00:00'`
    const url =
      `${this.sourceUrl}?$where=${encodeURIComponent(inForce)}` +
      `&$order=vigenciadesde%20DESC&$limit=1`
    let rows: unknown
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      rows = await response.json()
    } catch (error) {
      this.log.error(`TRM source unavailable: ${(error as Error).message}`)
      throw exchangeRateUnavailable()
    }
    // The filter is the source's; the row is checked again so a future or expired one never prices.
    const row = Array.isArray(rows)
      ? (rows as TrmRow[]).find((r) => isInForce(r, today))
      : undefined
    const rate = Number(row?.valor)
    if (!row || !Number.isFinite(rate) || rate < MIN_CREDIBLE_RATE || rate > MAX_CREDIBLE_RATE) {
      this.log.error(
        `TRM source returned no usable row for ${today}: ${JSON.stringify(rows ?? null)}`,
      )
      throw exchangeRateUnavailable()
    }
    const value = { rate, date: dayOf(row.vigenciadesde) }
    const until = dayOf(row.vigenciahasta)
    return { value, until }
  }
}

// The source sends dates without a zone; slicing avoids a timezone shifting the day.
function dayOf(value: unknown): string {
  const day = typeof value === 'string' ? value.slice(0, 10) : ''
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : ''
}

function isInForce(row: TrmRow, today: string): boolean {
  const since = dayOf(row?.vigenciadesde)
  const until = dayOf(row?.vigenciahasta)
  return !!since && !!until && since <= today && today <= until
}

/** 503 `EXCHANGE_RATE_UNAVAILABLE`: no rate to charge with, so the payment is not created. */
export function exchangeRateUnavailable(): RequestException {
  return new RequestException(
    { code: 'EXCHANGE_RATE_UNAVAILABLE', message: 'No TRM is available to charge this payment' },
    HttpStatus.SERVICE_UNAVAILABLE,
  )
}
