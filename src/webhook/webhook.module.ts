import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BullModule } from '@nestjs/bullmq'
import { WebhookEvent } from './entities/webhookEvent.entity'
import { Payment } from '../payment/entities/payment.entity'
import { WebhookController } from './webhook.controller'
import { WebhookService } from './webhook.service'
import { WebhookRetryProcessor } from './webhook.processor'
import { PaymentModule } from '../payment/payment.module'

@Module({
  imports: [
    TypeOrmModule.forFeature([WebhookEvent], 'DBWrite'),
    TypeOrmModule.forFeature([WebhookEvent, Payment], 'DBRead'),
    BullModule.registerQueue({ name: 'webhook-retry' }),
    PaymentModule,
  ],
  controllers: [WebhookController],
  providers: [WebhookService, WebhookRetryProcessor],
  exports: [WebhookService],
})
export class WebhookModule {}
