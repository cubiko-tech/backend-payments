/**
 * Contrato de rechazo LOCAL del cliente de suscripciones de ConfioPagos.
 *
 * Vive en su propio módulo (y no dentro de `confio.provider.ts`) para romper el
 * ciclo `confio.provider.ts → confio-buyer.ts → confio.provider.ts`: en CommonJS
 * ese ciclo deja la clase base `undefined` mientras se evalúa el módulo, y
 * cualquier `extends` o referencia temprana explota. `confio.provider.ts`
 * re-exporta lo de acá, así que el path de import histórico sigue vivo.
 */

/** Prefijo de todo mensaje de `ConfioSubscriptionInputError`. */
export const CONFIO_SUBSCRIPTION_INPUT_ERROR = 'ConfioSubscription rechazada'

/** Códigos de rechazo local, ANTES de tocar la red. */
export type ConfioSubscriptionInputErrorCode =
  | 'missing_buyer_or_plan'
  | 'invalid_buyer'
  | 'plan_store_mismatch'
  | 'invalid_subscription_name'

/**
 * Rechazo de entrada del cliente de suscripciones: la petición nunca salió.
 *
 * **Este error es contrato con el alta** (`alta-crea-suscripcion-en-confiopagos`),
 * que necesita rechazar «con un código propio, no con un 422 opaco de Confío».
 * Se mapea por `instanceof` + `code` + `field`, NUNCA por el texto del mensaje.
 * Si cambiás `code` o `field`, actualizá ese mapeo.
 */
export class ConfioSubscriptionInputError extends Error {
  constructor(
    readonly code: ConfioSubscriptionInputErrorCode,
    readonly field: string,
    detail: string,
  ) {
    super(`${CONFIO_SUBSCRIPTION_INPUT_ERROR} [${code}] ${field}: ${detail}`)
    this.name = 'ConfioSubscriptionInputError'
  }
}
