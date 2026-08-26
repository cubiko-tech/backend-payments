import { Injectable, Logger } from '@nestjs/common'

/** Roles de marca que pueden ver el crédito: dueño, admin y financiero. */
const ALLOWED_BRAND_ROLES = ['superuser', 'admin', 'financial']

interface BrandMember {
  user?: string | { id?: string }
  rol?: string | { name?: string }
  rolName?: string
}

/**
 * No se pudo PREGUNTAR por la marca: backend-platform no respondió, respondió
 * un status inesperado o el servicio no está configurado. Es un fallo del
 * CANAL, transitorio, y NO dice nada sobre la marca. Aguas arriba corresponde
 * un 503, nunca degradar al usuario.
 */
export const BRAND_LOOKUP_UNAVAILABLE = 'BRAND_LOOKUP_UNAVAILABLE'

/** Se preguntó y platform contestó que esa marca no existe. Definitivo (4xx). */
export const BRAND_NOT_FOUND = 'BRAND_NOT_FOUND'

/** La marca existe pero no tiene país cargado. Definitivo (4xx). */
export const BRAND_WITHOUT_COUNTRY = 'BRAND_WITHOUT_COUNTRY'

export type BrandCountryErrorCode =
  | typeof BRAND_LOOKUP_UNAVAILABLE
  | typeof BRAND_NOT_FOUND
  | typeof BRAND_WITHOUT_COUNTRY

/**
 * Resultado discriminado por `ok`, mismo molde que `PriceResolution` en
 * `client-roles.service.ts`. Los `?: never` de la rama contraria están a
 * propósito: el tsconfig del servicio tiene `strictNullChecks: false` y sin
 * ellos TypeScript NO estrecha la unión por un discriminante booleano, así que
 * un consumidor que hiciera `if (!res.ok) res.code` no compilaría.
 */
export type BrandCountryResolution =
  | { ok: true; country: string; code?: never }
  | { ok: false; code: BrandCountryErrorCode; country?: never }

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

  /**
   * País registrado de la marca, normalizado (trim + mayúsculas), o `null`.
   * Envoltorio fino de `resolveBrandCountry`: nunca lanza, y colapsa los tres
   * modos de fallo en `null` para quien sólo quiera el dato. Quien necesite
   * distinguir "no pude preguntar" de "esa marca no está" usa el otro método.
   *
   * SONDA REAL (2026-08-25) contra dev por HTTPS vía gateway,
   * `GET https://app.roaxai.dev/platform/v1/brand/:id` con `Bearer ACCESS_SERVER`,
   * brandId `72a8463b-…-66a0985a10e6`. Cuatro formas observadas:
   * - token válido + marca existente → **200**, 636 bytes,
   *   `{"data":{ id, createdAt, updatedAt, name, slug, description, country:"CO",
   *   currency, owner, state, plan, provider, isDeleted, estimatedSales,
   *   industry, industrySlug, categories, flag }}` (18 claves; valores
   *   enmascarados salvo `country`);
   * - sin token o con token inválido → **404** `{"message":"Not Found","statusCode":404}`;
   * - UUID inexistente con token válido → **200** `{}`;
   * - brandId no-UUID → **400** `Validation failed (uuid is expected)`.
   */
  async getBrandCountry(brandId: string): Promise<string | null> {
    const result = await this.resolveBrandCountry(brandId)
    return result.ok ? result.country : null
  }

  /**
   * Resolver el país de la marca distinguiendo los dos modos de fallo, porque
   * aguas arriba mapean distinto (transitorio → 503, definitivo → 4xx) y una
   * distinción que sólo vive en un `logger.warn` no es accionable.
   *
   * Por qué el 404 es TRANSITORIO y no "marca inexistente": platform lanza
   * `NotFoundException` para CUALQUIER GET cuyo token no resuelva
   * (`backend-platform/src/shared/middleware/auth.middleware.ts:35`). Leer ese
   * 404 como un hecho sobre la marca convertiría una caída de auth en una
   * degradación del usuario. El hecho definitivo "esa marca no está" es el
   * **200 con `{}`**: el controller devuelve `{ data: (await findById())[0] }`
   * (`brand.controller.ts:109`), y sin fila `data` queda `undefined`.
   *
   * Se normaliza aunque `brand.entity.ts:110,121` ya haga `toUpperCase()`: esos
   * hooks son `@BeforeInsert`/`@BeforeUpdate`, así que filas viejas o cargadas
   * por SQL/fixtures pueden llegar en minúsculas o con espacios.
   *
   * Limitación consciente: un brandId no-UUID hace que platform responda 400
   * (`ParseUUIDPipe`) y cae acá en la rama transitoria, aunque sea un fallo
   * definitivo del llamador. En payments el brandId viene de un DTO ya
   * validado; si aparece un camino con id libre, hay que darle su propio código.
   *
   * DEUDA CONOCIDA: sin caché. Es una llamada por alta, pero si un camino
   * caliente lo consume habrá que cachear como hace `ClientRolesService`.
   */
  async resolveBrandCountry(brandId: string): Promise<BrandCountryResolution> {
    if (!this.platformUrl) {
      this.logger.warn('SERVICE_PLATFORM no configurado — país de la marca no disponible')
      return { ok: false, code: BRAND_LOOKUP_UNAVAILABLE }
    }
    try {
      const url = `${this.platformUrl}/v1/brand/${encodeURIComponent(brandId)}`
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessServer}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        this.logger.warn(
          `backend-platform brand/:id respondió ${response.status} — país no consultable`,
        )
        return { ok: false, code: BRAND_LOOKUP_UNAVAILABLE }
      }

      const body = await response.json()
      const brand = body?.data
      if (!brand) {
        this.logger.warn(`backend-platform no conoce la marca ${brandId}`)
        return { ok: false, code: BRAND_NOT_FOUND }
      }

      const raw = brand.country
      const country = typeof raw === 'string' ? raw.trim().toUpperCase() : ''
      if (!country) {
        this.logger.warn(`La marca ${brandId} no tiene país registrado`)
        return { ok: false, code: BRAND_WITHOUT_COUNTRY }
      }

      return { ok: true, country }
    } catch (error) {
      this.logger.error(`Error consultando el país de la marca en platform: ${error.message}`)
      return { ok: false, code: BRAND_LOOKUP_UNAVAILABLE }
    }
  }
}
