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
