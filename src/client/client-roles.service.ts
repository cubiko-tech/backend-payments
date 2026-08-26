import { Injectable, Logger } from '@nestjs/common'

/**
 * Cliente para consultar precios de planes desde backend-roles.
 * Mantiene un caché en memoria con TTL configurable para evitar
 * consultas excesivas al servicio de roles.
 */

/**
 * Fila de precio tal como la devuelve `GET /v1/plan` de backend-roles en la
 * relación `prices` (tabla `plan_prices`). Se guarda completa —con país e
 * `isDefault`— porque el precio correcto depende del país de la marca, no solo
 * de la moneda.
 */
export interface PlanPriceRow {
  id: string
  countryCode: string
  currency: string
  price: number
  isDefault: boolean
}

/** El plan pedido no está en el catálogo de backend-roles. */
export const PLAN_NOT_FOUND = 'PLAN_NOT_FOUND'

/** El plan existe pero no tiene fila para ese país ni fila `isDefault`. */
export const PRICE_NOT_FOUND_FOR_COUNTRY = 'PRICE_NOT_FOUND_FOR_COUNTRY'

export type PriceResolutionErrorCode =
  | typeof PLAN_NOT_FOUND
  | typeof PRICE_NOT_FOUND_FOR_COUNTRY

/**
 * Resultado discriminado por `ok`. Los `?: never` de la rama contraria están a
 * propósito: el tsconfig del servicio tiene `strictNullChecks: false`, y sin él
 * TypeScript NO estrecha la unión por un discriminante booleano. Sin esos
 * campos, un consumidor que hiciera `if (!res.ok) res.code` no compilaría.
 */
export type PriceResolution =
  | { ok: true; price: PlanPriceRow; code?: never }
  | { ok: false; code: PriceResolutionErrorCode; price?: never }

interface PlanPricesCache {
  prices: Map<string, PlanPriceRow[]> // planSlug → filas de precio
  fetchedAt: number
}

@Injectable()
export class ClientRolesService {
  private readonly logger = new Logger(ClientRolesService.name)

  private get rolesUrl(): string {
    return process.env.SERVICE_ROLES || ''
  }

  private get accessServer(): string {
    return process.env.ACCESS_SERVER || ''
  }

  // Caché en memoria: TTL 5 minutos
  private cache: PlanPricesCache | null = null
  private readonly CACHE_TTL_MS = 5 * 60 * 1000

  /**
   * Obtener precio de un plan en una moneda específica.
   * Retorna null si el plan o moneda no existen.
   */
  async getPlanPrice(planSlug: string, currency: string): Promise<number | null> {
    const prices = await this.getAllPlanPrices()
    const planPrices = prices.get(planSlug)
    if (!planPrices) return null
    const price = planPrices.get(currency)
    return price !== undefined ? price : null
  }

  /**
   * Obtener todos los precios de planes como mapa: planSlug → currency → price.
   * Derivado de las filas cacheadas.
   *
   * La dimensión país se colapsa: si dos filas comparten moneda (p. ej. COP
   * para CO y para EC) gana la última del array, exactamente como antes. Se
   * preserva a propósito porque `checkout.service.ts:490`,
   * `tasks.service.ts:435,537` y `metrics.service.ts:44` están fuera de alcance
   * y consumen esta forma. La respuesta correcta por país es
   * `resolvePriceForCountry`.
   */
  async getAllPlanPrices(): Promise<Map<string, Map<string, number>>> {
    const rowsByPlan = await this.getPlanRows()
    const pricesMap = new Map<string, Map<string, number>>()

    for (const [planSlug, rows] of rowsByPlan) {
      const currencyMap = new Map<string, number>()
      for (const row of rows) {
        currencyMap.set(row.currency, row.price)
      }

      // Plan free sin precios configurados → precio 0 (solo en esta derivación:
      // nunca se inventan filas en el caché).
      if (currencyMap.size === 0 && planSlug === 'free') {
        currencyMap.set('COP', 0)
        currencyMap.set('USD', 0)
      }

      pricesMap.set(planSlug, currencyMap)
    }

    return pricesMap
  }

  /**
   * Resolver el precio de un plan para un país concreto.
   *
   * Se elige la fila cuyo `countryCode` coincide (case-insensitive); si hay más
   * de una para ese país gana la que tenga `isDefault: true`, con independencia
   * del orden en que backend-roles las devuelva. Si no hay fila del país, se
   * cae a la fila `isDefault` del plan.
   *
   * Dos decisiones de borde deliberadas:
   * - un `countryCode` vacío o en blanco va directo a la fila `isDefault`;
   * - `free` (sin filas de precio reales) responde `PRICE_NOT_FOUND_FOR_COUNTRY`
   *   en vez de un cero fabricado, para que el alta no persista un id de precio
   *   inventado.
   *
   * La fila se devuelve por referencia desde el caché: quien la reciba no debe
   * mutarla o corrompe el precio para todos los consumidores hasta que expire.
   */
  async resolvePriceForCountry(planSlug: string, countryCode: string): Promise<PriceResolution> {
    const rowsByPlan = await this.getPlanRows()
    const rows = rowsByPlan.get(planSlug)
    if (!rows) return { ok: false, code: PLAN_NOT_FOUND }

    const wanted = (countryCode || '').trim().toUpperCase()

    if (wanted) {
      const matches = rows.filter((row) => row.countryCode.toUpperCase() === wanted)
      const winner = matches.find((row) => row.isDefault) ?? matches[0]
      if (winner) return { ok: true, price: winner }
    }

    const fallback = rows.find((row) => row.isDefault)
    if (fallback) return { ok: true, price: fallback }

    return { ok: false, code: PRICE_NOT_FOUND_FOR_COUNTRY }
  }

  /**
   * Filas de precio por plan, con caché en memoria de 5 minutos.
   *
   * DEUDA CONOCIDA: si backend-roles falla se devuelve el caché VENCIDO sin
   * tope de antigüedad, así que un outage prolongado sirve precios
   * arbitrariamente viejos —no hay edad máxima ni caché negativo—. El único
   * límite hoy es un `invalidateCache()` manual.
   */
  private async getPlanRows(): Promise<Map<string, PlanPriceRow[]>> {
    // Si hay caché válido, retornar
    if (this.cache && (Date.now() - this.cache.fetchedAt) < this.CACHE_TTL_MS) {
      return this.cache.prices
    }

    // Intentar refrescar desde backend-roles
    try {
      const fresh = await this.fetchPlanPricesFromRoles()
      this.cache = { prices: fresh, fetchedAt: Date.now() }
      return fresh
    } catch (error) {
      this.logger.warn(`Error al obtener precios de backend-roles: ${error.message}`)

      // Si hay caché expirado, usarlo como fallback
      if (this.cache) {
        this.logger.warn('Usando caché expirado como fallback')
        return this.cache.prices
      }

      // Sin caché ni servicio — retornar vacío
      this.logger.error('Sin caché ni conexión a backend-roles, precios no disponibles')
      return new Map()
    }
  }

  /**
   * Consultar GET /v1/plan en backend-roles y extraer las filas de precio.
   */
  private async fetchPlanPricesFromRoles(): Promise<Map<string, PlanPriceRow[]>> {
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

    for (const plan of Array.isArray(plans) ? plans : []) {
      const rows: PlanPriceRow[] = []

      if (Array.isArray(plan.prices)) {
        for (const price of plan.prices) {
          rows.push({
            id: String(price.id),
            countryCode: String(price.countryCode ?? ''),
            // `price` viaja como string: `plan_prices.price` es decimal en backend-roles.
            currency: String(price.currency),
            price: Number(price.price),
            isDefault: !!price.isDefault,
          })
        }
      }

      pricesMap.set(plan.slug, rows)
    }

    this.logger.log(`Precios actualizados desde backend-roles: ${pricesMap.size} planes`)
    return pricesMap
  }

  /**
   * Invalidar caché manualmente (útil después de cambios admin).
   */
  invalidateCache() {
    this.cache = null
  }

  /**
   * ¿El sujeto (user|brand) tiene el permiso efectivo? Consulta backend-roles
   * `GET /v1/effective/check/:subjectId/:slug` (O(1) sobre effective_permissions).
   * Fail-closed: ante error de red/servicio devuelve false (no concede acceso).
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
        `${this.rolesUrl}/v1/effective/check/${subjectId}/` +
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

  // =============================================================
  // Gestión de planes por marca (service-to-service)
  // =============================================================

  /**
   * Asignar plan a marca con fecha de expiración.
   */
  async assignPlanToBrand(brandId: string, planSlug: string, expiresAt?: Date): Promise<boolean> {
    return this.callRolesApi(
      `/v1/brand/${brandId}/plan/slug/${planSlug}`,
      'POST',
      expiresAt ? { expiresAt: expiresAt.toISOString() } : undefined,
      `Plan ${planSlug} asignado a marca ${brandId}`,
    )
  }

  /**
   * Remover plan de marca (al cancelar o expirar suscripción).
   */
  async removePlanFromBrand(brandId: string, planSlug: string): Promise<boolean> {
    return this.callRolesApi(
      `/v1/brand/${brandId}/plan/slug/${planSlug}`,
      'DELETE',
      undefined,
      `Plan ${planSlug} removido de marca ${brandId}`,
    )
  }

  /**
   * Renovar (extender expiresAt) plan de marca.
   */
  async renewPlanForBrand(brandId: string, planSlug: string, expiresAt: Date): Promise<boolean> {
    return this.callRolesApi(
      `/v1/brand/${brandId}/plan/slug/${planSlug}/renew`,
      'POST',
      { expiresAt: expiresAt.toISOString() },
      `Plan ${planSlug} renovado para marca ${brandId} hasta ${expiresAt.toISOString()}`,
    )
  }

  /**
   * Helper para llamadas HTTP a backend-roles.
   * No bloquea el flujo si falla — registra warning.
   */
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
