import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { ConfioSubscriptionInputError } from '../provider/confio/confio-subscription-error'
import { RequestException } from '../shared/exception/request.exception'

/**
 * Cancelación de la suscripción recurrente contra ConfioPagos.
 *
 * Adaptador delgado entre el dominio (`SubscriptionService.cancel`) y la
 * pasarela: hace la única llamada y traduce TODO fallo a un `RequestException`
 * con código propio, para que el dominio no tenga que interpretar errores de
 * ConfioPagos.
 *
 * **Por qué vive acá y no en `subscription.service.ts`** (dos motivos, los dos
 * cargan peso):
 *  1. Ese archivo ya tiene 628 líneas contra la guía de 400 del repo (R6);
 *     meterle la conversación con la pasarela lo empuja más lejos todavía.
 *  2. Es el MISMO corte que ya hacen `confio-trial.service.ts` y
 *     `webhook/confio-subscription-webhook.service.ts`: la conversación con la
 *     pasarela vive afuera del servicio de dominio, que se queda con la fila y
 *     sus invariantes.
 *
 * **DUPLICACIÓN CONSCIENTE**: el mapeo de `plan_store_mismatch` /
 * `invalid_subscription_name` repite el de `ConfioTrialService.inputErrorException`
 * (`confio-trial.service.ts`). Se prefiere la duplicación ANOTADA antes que
 * extraer un mapeador compartido, que obligaría a abrir un archivo que esta tarea
 * no nombra — el mismo criterio con el que `confio-trial.service.ts` declara su
 * duplicación de `planPricingException`. La extracción queda para el groomer.
 *
 * ⚠️ Confirmado contra dev el 2026-08-27: la cancelación de ConfioPagos es
 * IDEMPOTENTE (cancelar dos veces también responde 200). Por eso acá no hay
 * ninguna guarda de «ya estaba cancelada»: reintentar es seguro y el camino de
 * reparación es el mismo camino.
 */
@Injectable()
export class ConfioCancellationService {
  private readonly logger = new Logger(ConfioCancellationService.name)

  constructor(private readonly confio: ConfioProvider) {}

  /**
   * Cancela la suscripción en ConfioPagos. Resolver = ellos confirmaron con un
   * HTTP 200; su respuesta viene vacía, así que no hay nada que devolver.
   *
   * Dos salidas y ninguna tercera, igual que `ConfioTrialService.callConfio`:
   * - `ConfioSubscriptionInputError` (rechazo LOCAL, la petición nunca salió) →
   *   se desglosa por `code`, NUNCA por el texto del mensaje, que es el contrato
   *   declarado en `confio-subscription-error.ts`.
   * - cualquier otro fallo (4xx, 5xx, timeout, red) → 503 sin reexponer el cuerpo
   *   de ConfioPagos: un fallo del canal no es un hecho sobre el objeto.
   *
   * El `detail` del rechazo local NO viaja al cliente en ninguna rama: lleva el
   * store esperado o el `name` que tenemos guardado.
   */
  async cancel(name: string, reason: string): Promise<void> {
    try {
      await this.confio.cancelSubscription(name, reason)
    } catch (error) {
      if (error instanceof ConfioSubscriptionInputError) {
        this.logger.warn(
          `Cancelación en ConfioPagos rechazada localmente [${error.code}] en ${error.field}`,
        )
        throw ConfioCancellationService.inputErrorException(error)
      }

      // NO se loguea `error.message`: para un no-2xx ese texto es el que arma
      // `ConfioProvider.confioFetch` con el CUERPO ENTERO de la respuesta
      // serializado, que puede arrastrar datos del comprador al log. Va sólo el
      // status —o la clase del fallo si ni siquiera hubo respuesta—, que es lo
      // único que sirve para operar. Y se resuelve sin tocar `error.message`
      // directamente: un rechazo que no es `Error` haría explotar este catch y
      // subiría un 500 opaco.
      this.logger.error(
        `ConfioPagos no pudo cancelar la suscripción: ${ConfioCancellationService.resumirFallo(error)}`,
      )
      throw new RequestException(
        {
          code: 'CONFIO_CANCEL_UNAVAILABLE',
          message: 'No se pudo cancelar la suscripción en ConfioPagos, reintentá en unos minutos',
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }
  }

  /**
   * Resumen del fallo APTO PARA EL LOG. Dos salidas útiles y ninguna de texto
   * libre: el status HTTP cuando ConfioPagos respondió, y la clase del error
   * cuando el fallo fue nuestro o del canal. El cuerpo de la respuesta NO se
   * loguea nunca.
   */
  private static resumirFallo(error: unknown): string {
    if (!(error instanceof Error)) return `rechazo que no es Error (${typeof error})`
    const status = /^ConfioPagos error (\d{3})/.exec(error.message)?.[1]
    if (status) return `HTTP ${status}`
    if (error.message.startsWith('ConfioPagos no configurado')) return 'provider sin configurar'
    return error.name
  }

  /**
   * Desglosa los rechazos locales en sus dos naturalezas, que no se colapsan:
   *
   * - `plan_store_mismatch` e `invalid_subscription_name` son CONFIGURACIÓN o
   *   datos NUESTROS (el `name` lo persistimos nosotros): el usuario no tiene
   *   nada que corregir y reintentar con otros datos no cambia nada → 503 con su
   *   propio código, que es el que hay que buscar en el log. Los dos son
   *   ALCANZABLES desde acá: `ConfioProvider.cancelSubscription` valida el
   *   resource name entero antes de salir a la red (store propio + forma), la
   *   misma guarda que el alta.
   * - `missing_cancel_reason` sí es del llamador: mandó la baja sin motivo y
   *   ConfioPagos lo exige → 422 nombrando el campo.
   */
  private static inputErrorException(error: ConfioSubscriptionInputError): RequestException {
    switch (error.code) {
      case 'missing_cancel_reason':
        return new RequestException(
          {
            code: 'CANCEL_REASON_REQUIRED',
            message: 'ConfioPagos exige un motivo para cancelar la suscripción',
            field: error.field,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      case 'plan_store_mismatch':
        return new RequestException(
          {
            code: 'CONFIO_PLAN_STORE_MISMATCH',
            message: 'La integración con ConfioPagos está mal configurada, reintentá en unos minutos',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
      case 'invalid_subscription_name':
      default:
        return new RequestException(
          {
            code: 'CONFIO_SUBSCRIPTION_NAME_INVALID',
            message: 'La suscripción guardada no es cancelable en ConfioPagos, reintentá en unos minutos',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
    }
  }
}
