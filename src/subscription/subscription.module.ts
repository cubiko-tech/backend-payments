import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Subscription } from './entities/subscription.entity'
import { SubscriptionEvent } from './entities/subscriptionEvent.entity'
import { EnterprisePricing } from './entities/enterprisePricing.entity'
import { SubscriptionController } from './subscription.controller'
import { SubscriptionService } from './subscription.service'
import { EnterprisePricingService } from './enterprise-pricing.service'
import { ConfioTrialService } from './confio-trial.service'
import { PaymentModule } from '../payment/payment.module'

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, SubscriptionEvent, EnterprisePricing], 'DBWrite'),
    TypeOrmModule.forFeature([Subscription, SubscriptionEvent, EnterprisePricing], 'DBRead'),
    // El alta crea la suscripción en ConfioPagos: de acá salen `ConfioProvider` y
    // `ConfioPlanService`. La cadena queda `SubscriptionModule → PaymentModule →
    // WalletModule`, sin ciclo (`CheckoutModule` ya importa los dos).
    PaymentModule,
  ],
  controllers: [SubscriptionController],
  providers: [SubscriptionService, EnterprisePricingService, ConfioTrialService],
  exports: [SubscriptionService, EnterprisePricingService],
})
export class SubscriptionModule {}
