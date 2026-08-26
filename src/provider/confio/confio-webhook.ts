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
