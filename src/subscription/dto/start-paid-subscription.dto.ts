import { IsNotEmpty, IsOptional, IsString } from 'class-validator'

/**
 * Lista BLANCA del alta PAGA (`POST /subscription/paid` → `SubscriptionService.startPaid`).
 *
 * Mismo candado que `CreateSubscriptionDto`, y por el mismo motivo: el `ValidationPipe`
 * global (`main.ts`, `whitelist` + `forbidNonWhitelisted`) sólo filtra si el handler
 * declara un metatype. Lo que esta clase declara es exactamente lo que el llamador puede
 * mandar.
 *
 * Los tres campos que NO están, y qué pasaría si estuvieran:
 *   · `id` — con un `id` ajeno el `save` deja de INSERTAR y pasa a UPDATEar la fila de
 *     otra marca. Sin él, el índice único por `brandId` es el que decide.
 *   · `trialStart` / `trialEnd` — son la marca DURABLE de prueba consumida (invariante
 *     al lado de la columna en `subscription.entity.ts`). Este endpoint existe JUSTAMENTE
 *     para la marca que ya gastó su prueba: dejar que la mande en `null` le devolvería el
 *     trial gratis por la puerta de al lado.
 *
 * Tampoco hay `provider` ni `walletId`: el alta paga se crea en ConfioPagos, que es el
 * único medio de la épica. `startTrial` los recibe y los RECHAZA (`TRIAL_PROVIDER_NOT_SUPPORTED`)
 * por compatibilidad con su contrato viejo; acá el contrato nace limpio y directamente no
 * los admite — un body con `provider` rebota en el `ValidationPipe`, sin llegar al servicio.
 */
export class StartPaidSubscriptionDto {
  @IsString()
  @IsNotEmpty()
  brandId: string

  @IsString()
  @IsNotEmpty()
  userId: string

  @IsString()
  @IsNotEmpty()
  planSlug: string

  /**
   * Teléfono de la cuenta de ConfioPagos que va a pagar, cuando no es el del
   * perfil. OPCIONAL: sin él se usa el de la cuenta, que es el caso común.
   *
   * No se valida el formato acá sino en `buildConfioBuyer`, que ya normaliza a
   * E.164 usando el `callingCode` del usuario y rechaza antes de tocar la red.
   * Duplicar la regla en el DTO daría dos criterios que pueden divergir.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  billingPhone?: string
}
