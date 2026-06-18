import { Injectable, OnModuleInit } from '@nestjs/common'
import { PaymentProvider } from './provider.interface'
import { StripeProvider } from './stripe/stripe.provider'
import { MercadoPagoProvider } from './mercadopago/mercadopago.provider'
import { DropiProvider } from './dropi/dropi.provider'
import { logger } from '../shared/logger/logger'

/**
 * Registry de proveedores de pago.
 *
 * Cada provider se auto-registra al iniciar el módulo.
 * Para agregar un nuevo provider (Wompi, PayU, etc.):
 * 1. Crear clase que implemente PaymentProvider
 * 2. Inyectarla en el constructor de este registry
 * 3. Se registra automáticamente si está configurado
 *
 * El checkout consulta getAvailableProviders() para saber cuáles están activos.
 */
@Injectable()
export class ProviderFactory implements OnModuleInit {
  private readonly registry = new Map<string, PaymentProvider>()

  constructor(
    private readonly stripeProvider: StripeProvider,
    private readonly mercadoPagoProvider: MercadoPagoProvider,
    private readonly dropiProvider: DropiProvider,
  ) {}

  onModuleInit() {
    // Auto-registrar providers que estén configurados
    const providers: PaymentProvider[] = [
      this.stripeProvider,
      this.mercadoPagoProvider,
      this.dropiProvider,
    ]

    for (const provider of providers) {
      this.register(provider)
    }

    logger.log('info', `ProviderRegistry: ${this.registry.size} proveedores registrados: [${Array.from(this.registry.keys()).join(', ')}]`)
  }

  /**
   * Registrar un provider en el registry.
   * Solo se registra si está configurado (no lanza error al crear checkout).
   */
  register(provider: PaymentProvider) {
    this.registry.set(provider.name, provider)
  }

  /**
   * Obtener un provider por nombre. Lanza error si no existe.
   */
  getProvider(name: string): PaymentProvider {
    const provider = this.registry.get(name)
    if (!provider) {
      throw new Error(`Payment provider '${name}' no registrado. Disponibles: [${Array.from(this.registry.keys()).join(', ')}]`)
    }
    return provider
  }

  /**
   * Verificar si un provider está registrado.
   */
  hasProvider(name: string): boolean {
    return this.registry.has(name)
  }

  /**
   * Obtener lista de providers registrados.
   */
  getAvailableProviders(): string[] {
    return Array.from(this.registry.keys())
  }

  /**
   * Obtener todos los providers como mapa.
   */
  getAllProviders(): Map<string, PaymentProvider> {
    return new Map(this.registry)
  }

  /**
   * Acceso directo al provider de Dropi (para batch charges).
   */
  getDropiProvider(): DropiProvider {
    return this.dropiProvider
  }
}
