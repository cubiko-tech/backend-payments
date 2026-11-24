// R6: one responsibility, the HTTP client of backend-roles (plan catalog and plan moves) and its cache.
import { Injectable, Logger } from '@nestjs/common'

/**
 * Price row as `GET /v1/plan` returns it in `prices`. Kept whole, with country and `isDefault`,
 * because the right price depends on the brand country, not only on the currency.
 */
export interface PlanPriceRow {
  id: string
  countryCode: string
  currency: string
  price: number
  /** `price` in integer cents, parsed from the decimal string; NaN when the row has no valid amount. */
  priceCents: number
  isDefault: boolean
}

/** The plan is not in the backend-roles catalog. */
export const PLAN_NOT_FOUND = 'PLAN_NOT_FOUND'

/** The plan exists but has no row for that country and no USD row. */
export const PRICE_NOT_FOUND_FOR_COUNTRY = 'PRICE_NOT_FOUND_FOR_COUNTRY'

/**
 * Currency for whoever has no own price: every country without a row, and any signup whose
 * gateway currency is switched off.
 */
export const FALLBACK_CURRENCY = 'USD'

/**
 * The plan's USD row, or `undefined` if the catalog declares none. Shared by country resolution
 * and the signup currency fallback so there is a single definition of the USD row.
 */
const findUsdRow = (
  rows: PlanPriceRow[],
  warn: (message: string) => void,
): PlanPriceRow | undefined => {
  const usd = rows.filter((row) => String(row.currency || '').toUpperCase() === FALLBACK_CURRENCY)
  return pickPriceRow(usd, warn)
}

/** Orders ids ascending: numerically when both are digit strings, as plain strings otherwise. */
const compareIds = (a: string, b: string): number => {
  if (/^\d+$/.test(a) && /^\d+$/.test(b) && a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The row that prices a set of candidates: the `isDefault` one, and the lowest `id` among several
 * defaults or among none, so the winner never depends on the order backend-roles returns them in.
 * Two defaults for the same country break the `isDefault` contract and are reported through `warn`.
 */
export const pickPriceRow = (
  rows: readonly PlanPriceRow[],
  warn: (message: string) => void,
): PlanPriceRow | undefined => {
  const defaults = rows.filter((row) => row.isDefault)
  const countries = new Set(defaults.map((row) => row.countryCode))
  if (countries.size < defaults.length) {
    warn(
      `More than one isDefault price row for one country: ${defaults.map((row) => row.id).join(', ')}`,
    )
  }
  return [...(defaults.length ? defaults : rows)].sort((a, b) => compareIds(a.id, b.id))[0]
}

/** Integer cents of a decimal amount without going through a float; NaN when it is not one. */
const decimalToCents = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : NaN
  const match = /^\s*(-?)(\d+)(?:\.(\d{1,2}))?\s*$/.exec(typeof value === 'string' ? value : '')
  if (!match) return NaN
  const cents = Number(match[2]) * 100 + Number((match[3] ?? '').padEnd(2, '0'))
  return match[1] ? -cents : cents
}

export type PriceResolutionErrorCode = typeof PLAN_NOT_FOUND | typeof PRICE_NOT_FOUND_FOR_COUNTRY

/**
 * Result discriminated by `ok`. The `?: never` fields are deliberate: with `strictNullChecks: false`
 * TypeScript does not narrow on a boolean discriminant, and `if (!res.ok) res.code` would not compile.
 */
export type PriceResolution =
  | { ok: true; price: PlanPriceRow; code?: never }
  | { ok: false; code: PriceResolutionErrorCode; price?: never }

interface PlanPricesCache {
  prices: Map<string, PlanPriceRow[]> // planSlug -> price rows
  tokensPerCycle: Map<string, number>
  fetchedAt: number
}

/** Oldest catalog the cycle bonus accepts when backend-roles does not answer; older, it throws. */
export const BONUS_CATALOG_MAX_AGE_MS = 30 * 60 * 1000

/** Tokens a plan gives per paid cycle: a positive safe integer, or 0 for anything else. */
function tokensPerCycleOf(value: unknown): number {
  if (typeof value !== 'number' && typeof value !== 'string') return 0
  const tokens = Number(value)
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0
}

/**
 * Contract with backend-roles on `isDefault`: within one plan, at most one row per country is
 * `isDefault`, and it is the price of that country when it has several rows. backend-roles does not
 * enforce it (`plan_prices` has no unique constraint), so this client treats it as a promise it checks:
 * `isDefault` counts only when it is `true` or `'true'`, a second default is logged, and every tie
 * falls to the lowest `id`.
 */
@Injectable()
export class ClientRolesService {
  private readonly logger = new Logger(ClientRolesService.name)
  // A batch resolves one price per subscription: each broken catalog row set is reported once per catalog.
  private readonly warnedThisCatalog = new Set<string>()
  private readonly warn = (message: string) => {
    if (this.warnedThisCatalog.has(message)) return
    this.warnedThisCatalog.add(message)
    this.logger.warn(message)
  }

  private get rolesUrl(): string {
    return process.env.SERVICE_ROLES || ''
  }

  private get accessServer(): string {
    return process.env.ACCESS_SERVER || ''
  }

  private cache: PlanPricesCache | null = null
  private inflightRefresh: Promise<PlanPricesCache> | null = null
  private readonly CACHE_TTL_MS = 5 * 60 * 1000

  /**
   * Price of a plan in a currency, in the units the charge takes; null if the plan or the currency is
   * missing. It is `getPlanPriceCents` divided at the edge where it is charged.
   */
  async getPlanPrice(planSlug: string, currency: string): Promise<number | null> {
    const cents = await this.getPlanPriceCents(planSlug, currency)
    return cents === null ? null : cents / 100
  }

  /**
   * Price of a plan in a currency, in integer cents; null if the plan or the currency is missing.
   *
   * Among the rows of that currency the winner is `pickPriceRow`'s, whatever their order. A `free`
   * plan with no rows prices 0 in COP and USD: the zero is made up here, never stored in the cache.
   */
  async getPlanPriceCents(planSlug: string, currency: string): Promise<number | null> {
    const rows = (await this.getPlanRows()).get(planSlug)
    if (!rows) return null
    if (rows.length === 0 && planSlug === 'free') {
      return currency === 'COP' || currency === FALLBACK_CURRENCY ? 0 : null
    }
    const row = pickPriceRow(
      rows.filter((candidate) => candidate.currency === currency),
      this.warn,
    )
    return row && Number.isSafeInteger(row.priceCents) ? row.priceCents : null
  }

  hasCachedPrices(): boolean {
    return this.cache !== null
  }

  /**
   * Price of a plan for a country: the row matching `countryCode` (case-insensitive), picked by
   * `pickPriceRow`. Without a country row it falls back to the plan's USD row, so selling outside
   * Colombia does not depend on loading a row per country.
   *
   * Deliberate edges:
   * - a blank `countryCode` goes straight to the USD row;
   * - a plan WITHOUT price rows answers `PRICE_NOT_FOUND_FOR_COUNTRY` instead of the
   *   zero `getPlanPriceCents` makes up, so a signup never stores an invented price. A
   *   `free` plan with real 0.00 rows resolves them and charges 0; this branch is not it.
   *
   * The row is returned by reference from the cache, frozen, so callers cannot mutate it.
   */
  async resolvePriceForCountry(planSlug: string, countryCode: string): Promise<PriceResolution> {
    const rowsByPlan = await this.getPlanRows()
    const rows = rowsByPlan.get(planSlug)
    if (!rows) return { ok: false, code: PLAN_NOT_FOUND }

    const wanted = (countryCode || '').trim().toUpperCase()

    if (wanted) {
      const matches = rows.filter((row) => row.countryCode.toUpperCase() === wanted)
      const winner = pickPriceRow(matches, this.warn)
      if (winner) return { ok: true, price: winner }
    }

    // Fall back to USD, never to another country's `isDefault` row: that would silently charge COP
    // to a brand in another country.
    const usd = findUsdRow(rows, this.warn)
    if (usd) return { ok: true, price: usd }

    return { ok: false, code: PRICE_NOT_FOUND_FOR_COUNTRY }
  }

  /**
   * Price rows per plan, cached for `CACHE_TTL_MS`.
   *
   * Known debt: when backend-roles fails the EXPIRED cache is served with no age limit, so a long
   * outage serves arbitrarily old prices; only a manual `invalidateCache()` bounds it.
   */
  private async getPlanRows(): Promise<Map<string, PlanPriceRow[]>> {
    if (this.cache && Date.now() - this.cache.fetchedAt < this.CACHE_TTL_MS) {
      return this.cache.prices
    }

    try {
      return (await this.refreshCatalog()).prices
    } catch (error) {
      this.logger.warn(`Error al obtener precios de backend-roles: ${error.message}`)

      if (this.cache) {
        this.logger.warn('Usando caché expirado como fallback')
        return this.cache.prices
      }

      this.logger.error('Sin caché ni conexión a backend-roles, precios no disponibles')
      return new Map()
    }
  }

  /**
   * Tokens the plan gives per paid cycle (`tokensPerCycle` in `GET /v1/plan`); 0 when the plan or
   * the field is missing. Serves a stale catalog only up to `BONUS_CATALOG_MAX_AGE_MS`.
   * @throws when backend-roles does not answer and no catalog that recent exists.
   */
  async getTokensPerCycle(planSlug: string): Promise<number> {
    let catalog = this.cache
    if (!catalog || Date.now() - catalog.fetchedAt >= this.CACHE_TTL_MS) {
      try {
        catalog = await this.refreshCatalog()
      } catch (error) {
        if (!catalog || Date.now() - catalog.fetchedAt >= BONUS_CATALOG_MAX_AGE_MS) {
          throw new Error(`Plan catalog unavailable for the cycle bonus: ${error.message}`)
        }
        this.logger.warn(`Cycle bonus read from a stale plan catalog: ${error.message}`)
      }
    }
    return catalog.tokensPerCycle.get(planSlug) ?? 0
  }

  /** Callers that find the cache expired at the same time share one call to backend-roles. */
  private refreshCatalog(): Promise<PlanPricesCache> {
    if (!this.inflightRefresh) {
      this.inflightRefresh = this.fetchCatalogFromRoles()
        .then((fresh) => {
          this.cache = { ...fresh, fetchedAt: Date.now() }
          this.warnedThisCatalog.clear()
          return this.cache
        })
        .finally(() => {
          this.inflightRefresh = null
        })
    }
    return this.inflightRefresh
  }

  /**
   * Reads `GET /v1/plan` from backend-roles: the price rows and the tokens per cycle of each plan.
   */
  private async fetchCatalogFromRoles(): Promise<Omit<PlanPricesCache, 'fetchedAt'>> {
    if (!this.rolesUrl) {
      throw new Error('SERVICE_ROLES no configurado')
    }

    const response = await fetch(`${this.rolesUrl}/v1/plan`, {
      headers: {
        'Authorization': `Bearer ${this.accessServer}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    })

    if (!response.ok) {
      throw new Error(`backend-roles respondió ${response.status}`)
    }

    const body = await response.json()
    const plans = body.data || body

    const pricesMap = new Map<string, PlanPriceRow[]>()
    const tokensPerCycle = new Map<string, number>()

    for (const plan of Array.isArray(plans) ? plans : []) {
      tokensPerCycle.set(plan.slug, tokensPerCycleOf(plan.tokensPerCycle))
      const rows: PlanPriceRow[] = []

      if (Array.isArray(plan.prices)) {
        for (const price of plan.prices) {
          // `price` arrives as a string because `plan_prices.price` is decimal in backend-roles.
          const priceCents = decimalToCents(price.price)

          // Frozen: rows are shared by reference from the cache, and one caller's mutation would
          // corrupt the price for everyone until the TTL expires.
          rows.push(
            Object.freeze({
              id: String(price.id),
              countryCode: String(price.countryCode ?? '')
                .trim()
                .toUpperCase(),
              currency: String(price.currency),
              price: priceCents / 100,
              priceCents,
              isDefault: price.isDefault === true || price.isDefault === 'true',
            }),
          )
        }
      }

      pricesMap.set(plan.slug, Object.freeze(rows) as PlanPriceRow[])
    }

    this.logger.log(`Precios actualizados desde backend-roles: ${pricesMap.size} planes`)
    return { prices: pricesMap, tokensPerCycle }
  }

  invalidateCache() {
    this.cache = null
  }

  /**
   * Whether the subject (user or brand) has the effective permission, per backend-roles.
   * Fail-closed: any network or service error returns false.
   */
  async checkPermission(
    subjectId: string,
    permissionSlug: string,
    type: 'user' | 'brand' = 'user',
  ): Promise<boolean> {
    if (!this.rolesUrl) {
      this.logger.warn('SERVICE_ROLES no configurado — permiso denegado (fail-closed)')
      return false
    }
    try {
      const url =
        `${this.rolesUrl}/v1/effective/check/${encodeURIComponent(subjectId)}/` +
        `${encodeURIComponent(permissionSlug)}?type=${type}`
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessServer}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        this.logger.warn(`backend-roles effective/check respondió ${response.status}`)
        return false
      }
      const body = await response.json()
      return !!body?.data?.hasPermission
    } catch (error) {
      this.logger.error(`Error consultando permiso en backend-roles: ${error.message}`)
      return false
    }
  }

  async assignPlanToBrand(brandId: string, planSlug: string, expiresAt?: Date): Promise<boolean> {
    return this.callRolesApi(
      `/v1/brand/${encodeURIComponent(brandId)}/plan/slug/${encodeURIComponent(planSlug)}`,
      'POST',
      expiresAt ? { expiresAt: expiresAt.toISOString() } : undefined,
      `Plan ${planSlug} asignado a marca ${brandId}`,
    )
  }

  async removePlanFromBrand(brandId: string, planSlug: string): Promise<boolean> {
    return this.callRolesApi(
      `/v1/brand/${encodeURIComponent(brandId)}/plan/slug/${encodeURIComponent(planSlug)}`,
      'DELETE',
      undefined,
      `Plan ${planSlug} removido de marca ${brandId}`,
    )
  }

  async renewPlanForBrand(brandId: string, planSlug: string, expiresAt: Date): Promise<boolean> {
    return this.callRolesApi(
      `/v1/brand/${encodeURIComponent(brandId)}/plan/slug/${encodeURIComponent(planSlug)}/renew`,
      'POST',
      { expiresAt: expiresAt.toISOString() },
      `Plan ${planSlug} renovado para marca ${brandId} hasta ${expiresAt.toISOString()}`,
    )
  }

  /** Never throws: a failed call is logged and returns false so it does not block the caller's flow. */
  private async callRolesApi(
    path: string,
    method: string,
    body?: any,
    successMessage?: string,
  ): Promise<boolean> {
    if (!this.rolesUrl) {
      this.logger.warn('SERVICE_ROLES no configurado')
      return false
    }

    try {
      const response = await fetch(`${this.rolesUrl}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${this.accessServer}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000),
      })

      if (response.ok) {
        if (successMessage) this.logger.log(successMessage)
        return true
      }

      const err = await response.json().catch(() => ({}))
      this.logger.warn(`Error en backend-roles (${response.status}): ${err.message || 'unknown'}`)
      return false
    } catch (error) {
      this.logger.error(`Error comunicándose con backend-roles: ${error.message}`)
      return false
    }
  }
}
