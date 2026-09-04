import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { TasksService } from './tasks.service'
import { Wallet } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { Payment } from '../payment/entities/payment.entity'
import { PaymentAttempt } from '../payment/entities/paymentAttempt.entity'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { WebhookEvent } from '../webhook/entities/webhookEvent.entity'
import { WalletModule } from '../wallet/wallet.module'
import { AuditModule } from '../audit/audit.module'
import { PaymentModule } from '../payment/payment.module'
import { CheckoutModule } from '../checkout/checkout.module'
import { WebhookModule } from '../webhook/webhook.module'

@Module({
  imports: [
    TypeOrmModule.forFeature(
      [Wallet, WalletBalanceSnapshot, Transaction, Payment, PaymentAttempt, Subscription, SubscriptionEvent, WebhookEvent],
      'DBWrite',
    ),
    TypeOrmModule.forFeature(
      [Wallet, WalletBalanceSnapshot, Transaction, Payment, Subscription, WebhookEvent],
      'DBRead',
    ),
    WalletModule,
    AuditModule,
    PaymentModule,
    CheckoutModule,
    // La repesca de altas sin confirmar reusa `ConfioSubscriptionWebhookService`: la
    // regla de qué se otorga vive allá y no se duplica acá.
    WebhookModule,
  ],
  providers: [TasksService],
})
export class TasksModule {}
