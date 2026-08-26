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

  /**
   * Caché en memoria de brandId → país, mismo molde que `ClientRolesService`.
   *
   * Existe porque `resolveBrandCountry` pasó a estar en el camino crítico del
   * checkout: sin caché, la disponibilidad del alta es el PRODUCTO de la de
   * payments por la de platform, y un parpadeo de platform convierte cada alta en
   * un 503. Sólo se cachean las resoluciones EXITOSAS (nunca los fallos), y ante
   * un fallo TRANSITORIO se sirve la entrada vencida antes que degradar al
   * usuario; un fallo definitivo (la marca no está, o perdió el país) borra la
   * entrada. Costo: un cambio de país en platform tarda hasta el TTL en verse.
   */
  private countryCache = new Map<string, { country: string; fetchedAt: number }>()
  private readonly COUNTRY_CACHE_TTL_MS = 5 * 60 * 1000
  /** Tope defensivo: el caché es por marca y el proceso es de larga vida. */
  private readonly COUNTRY_CACHE_MAX = 1000

  private get platformUrl(): string {
    return process.env.SERVICE_PLATFORM || ''
  }
  private get accessServer(): string {
    return process.env.ACCESS_SERVER || ''
  }

  /** Vaciar el caché de países (útil tras un cambio administrativo de marca). */
  invalidateCountryCache() {
    this.countryCache.clear()
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
   * DECISIÓN EXPLÍCITA: hoy no tiene consumidores de producción —el checkout usa
   * `resolveBrandCountry`, que es el que puede mapear cada fallo a su HTTP— y se
   * CONSERVA como API simple para consultas donde el país es informativo y un
   * `null` alcanza. Si dentro de un par de pases sigue sin llamador, se borra.
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
   * Cacheado 5 minutos (ver `countryCache`): es una llamada por alta, pero el alta
   * es el camino del dinero y no puede depender de que platform conteste siempre.
   */
  async resolveBrandCountry(brandId: string): Promise<BrandCountryResolution> {
    const cached = this.countryCache.get(brandId)
    if (cached && Date.now() - cached.fetchedAt < this.COUNTRY_CACHE_TTL_MS) {
      return { ok: true, country: cached.country }
    }

    const fresh = await this.fetchBrandCountry(brandId)

    if (fresh.ok) {
      this.rememberCountry(brandId, fresh.country)
      return fresh
    }

    // Fallo TRANSITORIO con entrada vencida: se sirve el país viejo. Un país no
    // cambia entre dos cobros, y la alternativa es un 503 en el alta por un
    // parpadeo de platform. Mismo criterio que el caché vencido de precios.
    if (fresh.code === BRAND_LOOKUP_UNAVAILABLE && cached) {
      this.logger.warn(`Usando el país cacheado de la marca ${brandId} (platform no responde)`)
      return { ok: true, country: cached.country }
    }

    // Fallo DEFINITIVO: platform contestó y dijo que esa marca no está, o que
    // perdió el país. Lo cacheado quedó desmentido.
    if (fresh.code !== BRAND_LOOKUP_UNAVAILABLE) this.countryCache.delete(brandId)

    return fresh
  }

  /** Guardar el país con tope de tamaño (el proceso es de larga vida). */
  private rememberCountry(brandId: string, country: string) {
    if (this.countryCache.size >= this.COUNTRY_CACHE_MAX) this.countryCache.clear()
    this.countryCache.set(brandId, { country, fetchedAt: Date.now() })
  }

  /** La consulta cruda a platform, sin caché: los modos de fallo viven acá. */
  private async fetchBrandCountry(brandId: string): Promise<BrandCountryResolution> {
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
