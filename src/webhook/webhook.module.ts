import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BullModule } from '@nestjs/bullmq'
import { WebhookEvent } from './entities/webhookEvent.entity'
import { Payment } from '../payment/entities/payment.entity'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { WebhookController } from './webhook.controller'
import { WebhookService } from './webhook.service'
import { WebhookRetryProcessor } from './webhook.processor'
import { ConfioSubscriptionWebhookService } from './confio-subscription-webhook.service'
import { PaymentModule } from '../payment/payment.module'

@Module({
  imports: [
    // Las dos entidades de suscripción se inyectan DIRECTO (como ya hacen
    // `tasks.service.ts` y `checkout.service.ts`) en vez de importar
    // `SubscriptionModule`: ese módulo arrastra `ClientRolesService`, y el corte
    // de acceso en roles es de otra tarea (`corte-de-acceso-al-primer-fallo`).
    TypeOrmModule.forFeature([WebhookEvent, Subscription, SubscriptionEvent], 'DBWrite'),
    TypeOrmModule.forFeature([WebhookEvent, Payment], 'DBRead'),
    BullModule.registerQueue({ name: 'webhook-retry' }),
    PaymentModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookRetryProcessor, ConfioSubscriptionWebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}
