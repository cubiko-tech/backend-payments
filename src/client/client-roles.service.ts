import { Injectable, Logger } from '@nestjs/common'

/**
 * Cliente para consultar precios de planes desde backend-roles.
 * Mantiene un caché en memoria con TTL configurable para evitar
 * consultas excesivas al servicio de roles.
 */

interface PlanPrice {
  planSlug: string
  currency: string
  price: number
}

interface PlanPricesCache {
  prices: Map<string, Map<string, number>> // planSlug → currency → price
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
   * Usa caché con TTL de 5 minutos.
   */
  async getAllPlanPrices(): Promise<Map<string, Map<string, number>>> {
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
   * Consultar GET /v1/plan en backend-roles y extraer precios.
   */
  private async fetchPlanPricesFromRoles(): Promise<Map<string, Map<string, number>>> {
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

    const pricesMap = new Map<string, Map<string, number>>()

    for (const plan of Array.isArray(plans) ? plans : []) {
      const currencyMap = new Map<string, number>()

      if (Array.isArray(plan.prices)) {
        for (const price of plan.prices) {
          currencyMap.set(price.currency, Number(price.price))
        }
      }

      // Plan free sin precios configurados → precio 0
      if (currencyMap.size === 0 && plan.slug === 'free') {
        currencyMap.set('COP', 0)
        currencyMap.set('USD', 0)
      }

      pricesMap.set(plan.slug, currencyMap)
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
