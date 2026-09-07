import { Subscription } from '../../subscription/entities/subscription.entity'
import { SubscriptionProvider } from '../../subscription/entities/subscription.entity'

/**
 * ¿Esta fila es una suscripción RECURRENTE de ConfioPagos, de las que cobran
 * ellos solos?
 *
 * **Por qué hace falta distinguirlo, y por qué no alcanza con el proveedor.**
 * `provider = 'confio'` cubre DOS modelos que conviven en la misma tabla:
 *
 * - El viejo, de pagos SUELTOS: cada período nosotros emitíamos un link de cobro
 *   nuevo (`issueExternalCharge`). Esas filas no tienen recurso de suscripción del
 *   lado de ellos; medido el 2026-09-04, en local hay una así (`expired`, con
 *   `providerSubscriptionId` nulo).
 * - El nuevo, de suscripción RECURRENTE, que trajo esta épica: existe un recurso
 *   `stores/{store}/subscription-plans/{plan}/subscriptions/{sub}` y **ConfioPagos
 *   cobra por su cuenta** en cada aniversario.
 *
 * Mirar sólo el proveedor mete a las dos en la misma bolsa, y ahí está el daño: a
 * una recurrente que renovó BIEN le emitiríamos un segundo cobro y la
 * marcaríamos `past_due`, que es el estado con el que se retira el plan pago. La
 * marca pagó, ellos cobraron, y nosotros le cortábamos el acceso.
 *
 * **El discriminador es el recurso, no una columna nueva**: si hay un nombre de
 * suscripción de ConfioPagos, la recurrencia vive allá. Se mira primero
 * `metadata.confio.name` y después `providerSubscriptionId`, el mismo orden y por
 * el mismo motivo que `nombreAnterior` en `subscription.service.ts`: el alta que
 * reemplaza una suscripción deja el nombre VIGENTE en metadata.
 */
const NOMBRE_DE_SUSCRIPCION = /\/subscriptions\/[^/]+$/

export function esSuscripcionRecurrenteDeConfio(sub: Subscription): boolean {
  if (sub?.provider !== SubscriptionProvider.CONFIO) return false

  const nombre = sub.metadata?.confio?.name || sub.providerSubscriptionId || ''

  return NOMBRE_DE_SUSCRIPCION.test(nombre)
}
