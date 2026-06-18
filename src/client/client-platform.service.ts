import { Injectable, Logger } from '@nestjs/common'

/** Roles de marca que pueden ver el crédito: dueño, admin y financiero. */
const ALLOWED_BRAND_ROLES = ['superuser', 'admin', 'financial']

interface BrandMember {
  user?: string | { id?: string }
  rol?: string | { name?: string }
  rolName?: string
}

/**
 * Cliente a backend-platform para verificar membresía de marca. Usado por el
 * gate de visibilidad del crédito (defense-in-depth además del BFF).
 */
@Injectable()
export class ClientPlatformService {
  private readonly logger = new Logger(ClientPlatformService.name)

  private get platformUrl(): string {
    return process.env.SERVICE_PLATFORM || ''
  }
  private get accessServer(): string {
    return process.env.ACCESS_SERVER || ''
  }

  /**
   * ¿El usuario es miembro de la marca con un rol que puede ver el crédito
   * (owner/admin/financiero)? Se filtra por `brand.id` (los miembros de ESA
   * marca; el filtro `?user=` no aplica con token de servicio). Fail-closed:
   * ante error de red/servicio devuelve false.
   */
  async canViewBrandCredit(userId: string, brandId: string): Promise<boolean> {
    if (!this.platformUrl) {
      this.logger.warn('SERVICE_PLATFORM no configurado — acceso denegado (fail-closed)')
      return false
    }
    try {
      const url =
        `${this.platformUrl}/v1/brand/rol/user?brand.id=${encodeURIComponent(brandId)}`
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessServer}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        this.logger.warn(`backend-platform brand/rol/user respondió ${response.status}`)
        return false
      }
      const body = await response.json()
      const rows: BrandMember[] = Array.isArray(body) ? body : body?.data ?? []
      const membership = rows.find(
        (r) => (typeof r.user === 'object' ? r.user?.id : r.user) === userId,
      )
      if (!membership) return false
      const role =
        typeof membership.rol === 'object'
          ? membership.rol?.name
          : membership.rol || membership.rolName
      return !!role && ALLOWED_BRAND_ROLES.includes(role)
    } catch (error) {
      this.logger.error(`Error verificando membresía en platform: ${error.message}`)
      return false
    }
  }
}
