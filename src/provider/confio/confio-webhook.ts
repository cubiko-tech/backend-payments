import { ConfioWebhookPayload } from './confio.types'

/**
 * Clave de idempotencia de un webhook de ConfioPagos.
 *
 * La clave identifica a la NOTIFICACIÓN, no al intento de entrega: Confío
 * reintenta mientras no reciba un 2xx, así que cada segmento tiene que ser un
 * campo que ellos reenvían byte a byte en la reentrega. Por eso `timestamp`
 * sirve —viaja dentro del checksum, o sea que una reentrega no puede cambiarlo
 * sin romper la firma— y la hora de recepción o `Date.now()` no sirven nunca:
 * harían única cada entrega y anularían la idempotencia entera.
 *
 * `signature.properties` NO se usa para armar la clave, aunque liste justo los
 * campos que identifican al evento: lo dicta el emisor, y una lista reordenada
 * acuñaría una clave nueva para la misma notificación.
 *
 * Contrato en `roax-ops/planning/CONFIOPAGOS_SUSCRIPCIONES.md` §Webhooks.
 */
/**
 * Ramo al que pertenece un evento de webhook de ConfioPagos.
 *
 * Los cuatro nombres son la tabla de eventos publicada del contrato
 * (`roax-ops/planning/CONFIOPAGOS_SUSCRIPCIONES.md` §Webhooks). El reparto NO es
 * cosmético, decide cómo se autentica cada evento:
 *
 *  - `firmado` — los dos eventos de suscripción, que traen objeto `signature` y
 *    se verifican con `verifyConfioWebhookSignature`.
 *  - `one_shot` — los dos eventos del link de pago, que hoy llegan SIN objeto
 *    `signature` (fixture vivo `confio-webhook.spec.ts`) y son tráfico EN VUELO:
 *    `webhook.service.ts:236-256` los despacha mirando `data.status` sin leer
 *    nunca el `eventType`. Silenciarlos apagaría cobros que están corriendo.
 *  - `fuera_de_contrato` — todo lo demás: no se sabe cómo autenticarlo, así que
 *    no se despacha.
 */
export type ConfioWebhookRamo = 'firmado' | 'one_shot' | 'fuera_de_contrato'

const EVENTOS_FIRMADOS = [
  'subscription.billingStatusChanged',
  'subscription.subscriptionStatusChanged',
]

const EVENTOS_ONE_SHOT = ['payment.statusChanged', 'paymentAttempt.statusChanged']

/**
 * Clasifica el `event` del envelope. Acepta `unknown` a propósito: el valor
 * viene del emisor y puede no ser ni siquiera un string.
 */
export function classifyConfioWebhookEvent(event: unknown): ConfioWebhookRamo {
  if (typeof event !== 'string') return 'fuera_de_contrato'
  if (EVENTOS_FIRMADOS.includes(event)) return 'firmado'
  if (EVENTOS_ONE_SHOT.includes(event)) return 'one_shot'

  return 'fuera_de_contrato'
}

export function buildConfioWebhookEventId(payload: ConfioWebhookPayload): string {
  const data = payload?.data || {}
  const event = payload?.event
  const resource = data.name || data.correlationId || 'unknown'

  // Cobro del ciclo: `name` + `status` se repiten en cada período (dos cobros
  // exitosos son los dos `SUCCEEDED` de la misma suscripción), así que el ciclo
  // es lo que los separa, y el discriminador de intento —`payment` en el éxito,
  // `failedCount` en el fallo— separa los reintentos dentro de un mismo ciclo.
  if (event === 'subscription.billingStatusChanged') {
    const cycle = data.cycleNumber !== undefined && data.cycleNumber !== null
      ? `ciclo-${data.cycleNumber}`
      // Degradado: el contrato dice que `cycleNumber` siempre viaja en este
      // evento. Si faltara, el timestamp firmado es lo único que sigue siendo
      // estable entre reentregas; una constante recrearía exactamente el bug.
      : `ts-${payload?.timestamp}`
    const attempt = data.payment
      ? data.payment
      : data.failedCount !== undefined && data.failedCount !== null
        ? `intento-${data.failedCount}`
        : ''

    return [resource, event, cycle, data.status || '', attempt].join(':')
  }

  // Cambio de estado de la suscripción: ACTIVE → PAST_DUE → ACTIVE es una
  // secuencia legítima con el mismo `name` y el mismo `status` en las puntas;
  // el instante del cambio es lo que las distingue.
  if (event === 'subscription.subscriptionStatusChanged') {
    const changedAt = data.updateTime || data.createTime || payload?.timestamp

    return [resource, event, data.status || '', changedAt].join(':')
  }

  // Camino legacy CONGELADO a propósito: los eventos del link de pago one-shot
  // que estén en vuelo durante el deploy tienen que seguir resolviendo a la
  // misma fila, o se procesarían por segunda vez.
  return `${resource}:${data.status || event}`
}
