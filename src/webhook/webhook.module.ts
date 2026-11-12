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
import { ClientModule } from '../client/client.module'
import { WalletModule } from '../wallet/wallet.module'
import { AuditModule } from '../audit/audit.module'
import { SubscriptionBonusService } from './subscription-bonus.service'

@Module({
  imports: [
    // Las dos entidades de suscripción se inyectan DIRECTO (como ya hacen
    // `tasks.service.ts` y `checkout.service.ts`) en vez de importar
    // `SubscriptionModule`: de ese módulo acá sólo se necesita
    // `ClientRolesService`, que entra por `ClientModule` y no arrastra el resto.
    TypeOrmModule.forFeature([WebhookEvent, Subscription, SubscriptionEvent], 'DBWrite'),
    TypeOrmModule.forFeature([WebhookEvent, Payment], 'DBRead'),
    BullModule.registerQueue({ name: 'webhook-retry' }),
    PaymentModule,
    // `ClientModule` es `@Global()` y ya entra por `app.module.ts`; se importa
    // igual, declarativo, como ya hace `credit.module.ts:38`: el corte de acceso
    // en roles al primer cobro fallido es una dependencia real de este módulo.
    ClientModule,
    WalletModule,
    AuditModule,
  ],
  controllers: [WebhookController],
  providers: [
    WebhookService,
    WebhookRetryProcessor,
    ConfioSubscriptionWebhookService,
    SubscriptionBonusService,
  ],
  // `ConfioSubscriptionWebhookService` se exporta porque la confirmación ACTIVA
  // (`SubscriptionService.confirm` y el barrido de repesca) aplica el MISMO efecto
  // que la notificación: la regla vive acá y no se duplica del otro lado. No hay
  // ciclo — este módulo NO importa `SubscriptionModule`, se inyecta las dos
  // entidades directo, que es justo el motivo por el que se hizo así.
  exports: [WebhookService, ConfioSubscriptionWebhookService],
})
export class WebhookModule {}
