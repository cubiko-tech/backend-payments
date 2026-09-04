import { DeepPartial } from 'typeorm'

import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'
import { ConfioWebhookPayload } from '../provider/confio/confio.types'

/**
 * Argumentos de la traza. `roles` se declara con una forma ESTRUCTURAL en vez de
 * importar `EfectoRoles`: la interfaz del handler encaja por tipado estructural
 * y así no hay que moverla ni exportarla sólo para esto.
 */
interface TrazaDelMovimiento {
  /** Fila de `subscriptions` YA LEÍDA BAJO EL LOCK. Ver punto (2) del header. */
  sub: Subscription
  fromStatus: string
  eventType: SubscriptionEventType
  toStatus: string
  payload: ConfioWebhookPayload
  providerEventId: string
  roles?: { accion: string; brandId: string; planSlug: string; expiresAt?: Date }
  /** Motivo del efecto cuando el payload no trae uno propio. */
  reason?: string
}

/**
 * Fila de `subscription_events` desde la que se reconstruye un movimiento de
 * ConfioPagos —marca, usuario, plan, monto, moneda, referencia y resultado— SIN
 * volver a preguntarle al proveedor (épica 002, `trazabilidad-de-movimientos`).
 *
 * Cuatro cosas que no se leen del código y hay que saber antes de tocarlo:
 *
 * (1) **Por qué vive aparte.** Mismo argumento que `confio-period.util.ts`:
 *     `confio-subscription-webhook.service.ts` ya está en 551 líneas, 40% sobre
 *     la guía de 400 del repo, y armar el registro de auditoría es otra
 *     responsabilidad que aplicar el efecto. Es una función pura: no es provider
 *     y no entra en `webhook.module.ts`.
 *
 * (2) **Esta fila SE SIRVE POR API.** `GET /subscription/history`
 *     (`subscription.controller.ts:111` → `subscription.service.ts:606-620`)
 *     hace `find()` sin `select` y devuelve las filas ENTERAS; el controller
 *     tiene autenticación SOLA —ningún `@RequirePermission` y ninguna validación
 *     de que el `brandId` pedido sea del que llama—. O sea que todo lo que caiga
 *     acá queda legible por cualquier usuario autenticado. Por eso el objeto es
 *     una lista CERRADA de campos dictados por la aceptación: prohibido agregar
 *     PII del comprador (`ConfioBuyer` trae email y teléfono), tokens o cualquier
 *     campo no acordado. El candado es el `toEqual` estricto del primer test de
 *     traza en `confio-subscription-webhook.service.spec.ts`, que se pone rojo
 *     ante cualquier clave nueva. No lo aflojes a `toMatchObject`.
 *
 * (3) **`providerRef` es una forma INVENTADA.** La aceptación pide «`data.name` y
 *     `data.payment`/`reason` según el resultado» pero no nombra el contenedor:
 *     se anida para no ensuciar la raíz del `metadata`. Es una decisión de forma
 *     sobre un historial que ya se sirve por API y que puede tener consumidores
 *     externos, así que queda explícita para poder discutirla y aplanarla.
 *
 * (4) **Acoplamiento con la deduplicación.** El predicado de idempotencia es
 *     `metadata ->> 'providerEventId'` (`buscarMarcador`), extracción de TEXTO en
 *     la RAÍZ del jsonb: `providerEventId` NO puede anidarse ni renombrarse, y
 *     ninguna clave anidada (`providerRef.*`, `roles.*`) debe llamarse igual.
 *     Romperlo hace que el marcador no se encuentre y que una reentrega aplique
 *     el efecto dos veces, o sea que regale un período (⚠️ plata). Estaba
 *     documentado sólo del lado del LECTOR; acá está el del escritor.
 *
 * No hay `try/catch` A PROPÓSITO: un catch dejaría sin escribir la fila que ES el
 * marcador de idempotencia y rompería el punto (4). La garantía es que este
 * armado NO PUEDE LANZAR —sólo lecturas de opcionales, cero `JSON.parse`, cero
 * `new Date()` sobre entrada cruda, cero non-null assertions—, y con
 * `strictNullChecks: false` en el tsconfig el compilador NO la sostiene: la
 * sostiene el test del payload mutilado. Si ese test desaparece, la garantía
 * desaparece con él.
 */
export function armarTrazaDelMovimiento({
  sub,
  fromStatus,
  eventType,
  toStatus,
  payload,
  providerEventId,
  roles,
  reason,
}: TrazaDelMovimiento): DeepPartial<SubscriptionEvent> {
  const data = payload?.data || {}

  // Sólo las claves que el payload trajo: el cobro exitoso da `payment`, el
  // fallido da `reason` y la cancelación ninguna de las dos. Si queda vacío se
  // omite entero en vez de escribir un objeto vacío.
  const providerRef = {
    ...(data.name ? { name: data.name } : {}),
    ...(data.payment ? { payment: data.payment } : {}),
    ...(data.reason ? { reason: data.reason } : {}),
  }

  return {
    subscriptionId: sub.id,
    eventType,
    fromStatus,
    toStatus,
    triggeredBy: 'confio-webhook',
    // La aceptación pide el motivo del fallo en la COLUMNA, no en el metadata.
    // El del payload GANA: es el que da el proveedor sobre el hecho concreto
    // (`INSUFFICIENT_FUNDS`); el del efecto es el respaldo para los cambios de
    // estado, que no traen motivo propio y aun así tienen que decir qué pasó.
    reason: data.reason || reason,
    metadata: {
      event: payload?.event,
      providerEventId,
      // De la fila BLOQUEADA, no releídos después (aceptación, punto 2).
      brandId: sub.brandId,
      userId: sub.userId,
      planSlug: sub.planSlug,
      amountCents: data.amountCents,
      currencyCode: data.currencyCode,
      cycleNumber: data.cycleNumber,
      ...(Object.keys(providerRef).length ? { providerRef } : {}),
      // `brandId`/`planSlug` aparecen DOS VECES en el mismo metadata y NO es
      // basura a limpiar: los de arriba salen de la fila bloqueada (lo que pide
      // la aceptación) y estos salen del efecto decidido ANTES del lock (lo que
      // exige `EfectoRoles`, para que lo empujado a roles y lo escrito sean el
      // MISMO dato). Pueden diferir legítimamente si otra escritura le cambió el
      // plan a la fila en el medio, y esa diferencia ES INFORMACIÓN sobre la
      // carrera: deduplicarlos rompe la aceptación o la traza del retiro.
      ...(roles
        ? {
            roles: {
              accion: roles.accion,
              brandId: roles.brandId,
              planSlug: roles.planSlug,
              expiresAt: roles.expiresAt?.toISOString(),
            },
          }
        : {}),
    },
  }
}
