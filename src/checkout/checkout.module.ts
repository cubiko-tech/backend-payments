import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { CheckoutController } from './checkout.controller'
import { CheckoutService } from './checkout.service'
import { Payment } from '../payment/entities/payment.entity'
import { PaymentAttempt } from '../payment/entities/paymentAttempt.entity'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { WalletModule } from '../wallet/wallet.module'
import { InvoiceModule } from '../invoice/invoice.module'
import { SubscriptionModule } from '../subscription/subscription.module'
import { AuditModule } from '../audit/audit.module'
import { TaxModule } from '../tax/tax.module'
import { DianModule } from '../dian/dian.module'
import { PaymentModule } from '../payment/payment.module'
import { WebhookModule } from '../webhook/webhook.module'

@Module({
  imports: [
    TypeOrmModule.forFeature(
      [Payment, PaymentAttempt, Subscription, SubscriptionEvent],
      'DBWrite',
    ),
    TypeOrmModule.forFeature([BillingProfile], 'DBRead'),
    WalletModule,
    InvoiceModule,
    SubscriptionModule,
    AuditModule,
    TaxModule,
    DianModule,
    PaymentModule,
    WebhookModule,
  ],
  controllers: [CheckoutController],
  providers: [CheckoutService],
  exports: [CheckoutService],
})
export class CheckoutModule {}
