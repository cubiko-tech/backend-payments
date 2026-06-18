import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Subscription } from './entities/subscription.entity'
import { SubscriptionEvent } from './entities/subscriptionEvent.entity'
import { EnterprisePricing } from './entities/enterprisePricing.entity'
import { SubscriptionController } from './subscription.controller'
import { SubscriptionService } from './subscription.service'
import { EnterprisePricingService } from './enterprise-pricing.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, SubscriptionEvent, EnterprisePricing], 'DBWrite'),
    TypeOrmModule.forFeature([Subscription, SubscriptionEvent, EnterprisePricing], 'DBRead'),
  ],
  controllers: [SubscriptionController],
  providers: [SubscriptionService, EnterprisePricingService],
  exports: [SubscriptionService, EnterprisePricingService],
})
export class SubscriptionModule {}
