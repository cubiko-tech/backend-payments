import { Injectable, Logger } from '@nestjs/common'
import { ConfioBuyerSource } from '../provider/confio/confio-buyer'

/**
 * No se pudo PREGUNTAR por el usuario: backend-auth no respondió, respondió un
 * status inesperado o el servicio no está configurado. Es un fallo del CANAL,
 * transitorio, y NO dice nada sobre el usuario. Aguas arriba corresponde un 503,
 * nunca un «tus datos están mal» — regla de negocio de la épica 002: «un fallo
 * del canal nunca se convierte en un hecho sobre el objeto».
 */
export const USER_LOOKUP_UNAVAILABLE = 'USER_LOOKUP_UNAVAILABLE'

/** Se preguntó y auth contestó que ese usuario no existe. Definitivo (4xx). */
export const USER_NOT_FOUND = 'USER_NOT_FOUND'

export type BuyerContactErrorCode = typeof USER_LOOKUP_UNAVAILABLE | typeof USER_NOT_FOUND

/**
 * Resultado discriminado por `ok`, mismo molde que `BrandCountryResolution` en
 * `client-platform.service.ts`. Los `?: never` de la rama contraria están a
 * propósito: el tsconfig del servicio tiene `strictNullChecks: false` y sin
 * ellos TypeScript NO estrecha la unión por un discriminante booleano.
 */
export type BuyerContactResolution =
  | { ok: true; contact: ConfioBuyerSource; code?: never }
  | { ok: false; code: BuyerContactErrorCode; contact?: never }

/**
 * Cliente a backend-auth para los datos de contacto del usuario autenticado.
 *
 * Existe porque el guard sólo pone `{id, isSuperAdmin, brand}` en `req.user`
 * (`src/shared/auth/api-auth.guard.ts:42`), y el comprador de una suscripción
 * de ConfioPagos necesita `email`, `name`, `phone` y `callingCode`.
 *
 * SONDA REAL (2026-08-26) contra dev por HTTPS vía gateway,
 * `GET https://auth.roaxai.dev/auth/v1/user/{id}` con `Bearer ACCESS_SERVER`.
 * Cuatro formas observadas:
 * - token válido + usuario existente → **200** `{"data":{…}}` con **20 claves**
 *   (`id`, `createdAt`, `updatedAt`, `email`, `phone`, `name`, `deletedAt`,
 *   `lastAccess`, `countryRegistration`, `callingCode`, `role`, `rol`, `status`,
 *   `isVerificated`, `isSuperAdmin`, `acceptTerms`, `changePassword`, `support`,
 *   `flags`, `ally`);
 * - UUID inexistente con token válido → **200 `[]`** (array vacío en la RAÍZ, no
 *   `{data:…}`): el controller devuelve `{data: safe}` sólo si encontró una fila,
 *   y si no devuelve el resultado crudo de `findEntity`
 *   (`backend-auth/src/data/user/controller/user.controller.ts:212-218`);
 * - sin token o con token inválido → **401** `{"code":"unauthorized",…}`;
 * - id no-UUID → **400** `{"message":"Validation failed (uuid is expected)",…}`.
 *
 * ⚠️ Sólo se extraen los CUATRO campos que necesita el comprador. Las otras 16
 * son PII y datos de autorización (`isSuperAdmin`, `flags`, `rol`, `status`) que
 * no deben viajar al buyer ni terminar en un log.
 *
 * 🔧 Deuda conocida: sin caché, a diferencia de `ClientPlatformService`. Es una
 * llamada por alta y los datos de contacto cambian sin aviso, así que un caché
 * serviría un teléfono viejo a un cobro recurrente. Si el alta pasa a consultarlo
 * en un camino caliente, hay que revisarlo.
 */
@Injectable()
export class ClientAuthService {
  private readonly logger = new Logger(ClientAuthService.name)

  private get authUrl(): string {
    return process.env.SERVICE_AUTH || ''
  }
  private get accessServer(): string {
    return process.env.ACCESS_SERVER || ''
  }

  /**
   * Datos de contacto del usuario, distinguiendo los dos modos de fallo porque
   * aguas arriba mapean distinto (transitorio → 503, definitivo → 4xx) y una
   * distinción que sólo vive en un `logger.warn` no es accionable.
   *
   * Limitación consciente: un id no-UUID hace que auth responda 400
   * (`ParseUUIDPipe`) y cae en la rama transitoria, aunque sea un fallo
   * definitivo del llamador. Mismo criterio que `ClientPlatformService`: el id
   * viene del guard, ya validado.
   */
  async resolveBuyerContact(userId: string): Promise<BuyerContactResolution> {
    if (!this.authUrl) {
      this.logger.warn('SERVICE_AUTH no configurado — contacto del usuario no consultable')
      return { ok: false, code: USER_LOOKUP_UNAVAILABLE }
    }
    try {
      const url = `${this.authUrl}/user/${encodeURIComponent(userId)}`
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.accessServer}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        this.logger.warn(
          `backend-auth user/:id respondió ${response.status} — contacto no consultable`,
        )
        return { ok: false, code: USER_LOOKUP_UNAVAILABLE }
      }

      const body = await response.json()
      // El 200 con `[]` es el hecho definitivo «ese usuario no está».
      const user = Array.isArray(body) ? null : body?.data
      if (!user || !user.id) {
        this.logger.warn(`backend-auth no conoce al usuario ${userId}`)
        return { ok: false, code: USER_NOT_FOUND }
      }

      return {
        ok: true,
        contact: {
          email: user.email,
          name: user.name,
          phone: user.phone,
          callingCode: user.callingCode,
        },
      }
    } catch (error) {
      this.logger.error(`Error consultando el contacto del usuario en auth: ${error.message}`)
      return { ok: false, code: USER_LOOKUP_UNAVAILABLE }
    }
  }
}
