import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Subscription } from './entities/subscription.entity'
import { SubscriptionEvent } from './entities/subscriptionEvent.entity'
import { EnterprisePricing } from './entities/enterprisePricing.entity'
import { SubscriptionController } from './subscription.controller'
import { SubscriptionService } from './subscription.service'
import { EnterprisePricingService } from './enterprise-pricing.service'
import { ConfioTrialService } from './confio-trial.service'
import { ConfioCancellationService } from './confio-cancellation.service'
import { PaymentModule } from '../payment/payment.module'
import { WebhookModule } from '../webhook/webhook.module'

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, SubscriptionEvent, EnterprisePricing], 'DBWrite'),
    TypeOrmModule.forFeature([Subscription, SubscriptionEvent, EnterprisePricing], 'DBRead'),
    // El alta crea la suscripción en ConfioPagos y la baja la cancela allá: de acá
    // salen `ConfioProvider` y `ConfioPlanService`. La cadena queda `SubscriptionModule → PaymentModule →
    // WalletModule`, sin ciclo (`CheckoutModule` ya importa los dos).
    PaymentModule,
    // La confirmación activa reusa el planificador y la escritura del webhook, en vez
    // de tener una segunda regla de qué se otorga. La flecha va en este sentido y no
    // al revés: `WebhookModule` no importa este módulo (se inyecta las entidades
    // directo), así que no hay ciclo.
    WebhookModule,
  ],
  controllers: [SubscriptionController],
  providers: [
    SubscriptionService,
    EnterprisePricingService,
    ConfioTrialService,
    ConfioCancellationService,
  ],
  exports: [SubscriptionService, EnterprisePricingService],
})
export class SubscriptionModule {}
