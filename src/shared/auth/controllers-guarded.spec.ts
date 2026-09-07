import { GUARDS_METADATA } from '@nestjs/common/constants'

import { AdminController } from '../../admin/admin.controller'
import { ApiAuthGuard } from './api-auth.guard'
import { BillingProfileController } from '../../billing-profile/billing-profile.controller'
import { CheckoutController } from '../../checkout/checkout.controller'
import { DianController } from '../../dian/dian.controller'
import { InvoiceController } from '../../invoice/invoice.controller'
import { MetricsController } from '../../metrics/metrics.controller'
import { PaymentController } from '../../payment/payment.controller'
import { PaymentMethodController } from '../../payment-method/payment-method.controller'
import { RefundController } from '../../refund/refund.controller'
import { SubscriptionController } from '../../subscription/subscription.controller'
import { WalletController } from '../../wallet/wallet.controller'
import { WebhookController } from '../../webhook/webhook.controller'

/**
 * Que ningún controller del servicio quede sin autenticar.
 *
 * El bug que esto cierra no era un guard equivocado: era `@UseGuards()` **sin
 * argumento**, un decorador que registra CERO guards. En una revisión de código
 * se lee como protegido y no protege nada — por eso sobrevivió a que se cerraran
 * `checkout` y `subscription` con el mismo patrón al lado.
 *
 * La lista se escribe a mano y a propósito: si mañana alguien agrega un
 * controller nuevo, este spec no lo va a detectar, pero el que agregue uno y lo
 * quiera exento tiene que venir acá a declararlo. Los que faltan de esta lista
 * son los deliberadamente públicos: `health` (lo sondea el panel admin y los
 * chequeos de despliegue) y `webhook` (autentica por su cuenta, con la firma o
 * el bearer del proveedor, y no puede exigir sesión).
 *
 * ⚠️ La exención de `webhook` era DEMASIADO ANCHA y costó un agujero: se escribió
 * pensando en los cuatro `@Post` de proveedor, pero el controller también tiene
 * tres handlers `admin/*` que quedaron abiertos a internet hasta el 2026-09-07
 * —`GET admin/events` daba 200 sin credencial en dev, staging y PRODUCCIÓN, y
 * `POST admin/:id/retry` reprocesaba de verdad—. El segundo bloque de este
 * archivo cierra esa mitad, y fija también que los `@Post` sigan SIN guard: la
 * corrección obvia —subir `ApiAuthGuard` a la clase— apagaría los webhooks
 * entrantes, porque ConfioPagos no manda cookie ni JWT nuestro.
 *
 * `ApiAuthGuard` autentica y nada más: sólo verifica permisos cuando el handler
 * declara `@RequirePermission`, así que agregarlo NO le suma requisitos de
 * permiso a nadie que hoy pase.
 */
const CONTROLLERS: ReadonlyArray<[string, new (...args: never[]) => unknown]> = [
  ['admin', AdminController],
  ['billing-profile', BillingProfileController],
  ['dian', DianController],
  ['invoice', InvoiceController],
  ['metrics', MetricsController],
  ['payment', PaymentController],
  ['payment-method', PaymentMethodController],
  ['refund', RefundController],
  ['wallet', WalletController],
  // Los dos que ya estaban cerrados: siguen acá para que nadie los reabra.
  ['checkout', CheckoutController],
  ['subscription', SubscriptionController],
]

describe('todos los controllers de payments exigen credencial', () => {
  // Mutación: devolver `@UseGuards()` vacío en cualquiera de ellos → su caso se
  // pone rojo, porque la metadata queda en lista vacía.
  it.each(CONTROLLERS)('%s declara ApiAuthGuard a nivel de clase', (_nombre, controller) => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, controller) ?? []

    expect(guards).toContain(ApiAuthGuard)
  })
})

/** Handlers de `WebhookController` que SÍ exigen credencial. */
const WEBHOOK_ADMIN = ['getAllWebhooks', 'getFailedWebhooks', 'retryWebhook'] as const

/** Handlers de `WebhookController` que NO pueden exigirla: los manda el proveedor. */
const WEBHOOK_PROVEEDOR = ['stripe', 'mercadopago', 'dropi', 'confio'] as const

function guardsDelHandler(nombre: string): unknown[] {
  // `Reflect.get` y no un índice con cast: el cast a `Record<string, unknown>`
  // no compila (los tipos no se solapan) y forzarlo con `as unknown as` taparía
  // un nombre de handler mal escrito, que es justo lo que dejaría el spec verde
  // sin estar mirando nada. Acá un nombre inexistente da `handler: undefined` y
  // el caso se pone rojo.
  const handler: unknown = Reflect.get(WebhookController.prototype, nombre)

  return (Reflect.getMetadata(GUARDS_METADATA, handler as object) ?? []) as unknown[]
}

describe('webhook: el guard va por handler, no en la clase', () => {
  // Mutación A: borrar `@UseGuards(ApiAuthGuard)` de cualquiera de los tres
  // `admin/*` → su caso se pone rojo. Es el agujero que existió de verdad.
  it.each(WEBHOOK_ADMIN)('%s exige ApiAuthGuard', (nombre) => {
    expect(guardsDelHandler(nombre)).toContain(ApiAuthGuard)
  })

  // Mutación B: agregar `@UseGuards(ApiAuthGuard)` a cualquiera de los cuatro
  // `@Post` de proveedor → su caso se pone rojo. Sin esto, "cerrar el controller"
  // parece un endurecimiento y en realidad apaga el cobro: los webhooks de
  // ConfioPagos empezarían a rebotar con 401 y nadie lo vería hasta el primer
  // cobro perdido.
  it.each(WEBHOOK_PROVEEDOR)('%s NO exige ApiAuthGuard', (nombre) => {
    expect(guardsDelHandler(nombre)).not.toContain(ApiAuthGuard)
  })

  // El guard de CLASE tiene que seguir ausente: si aparece, corre para todos los
  // handlers y las dos mitades de arriba dejarían de decir la verdad.
  it('WebhookController no declara guard a nivel de clase', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, WebhookController) ?? []).toEqual([])
  })
})
