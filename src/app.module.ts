import { ConfigModule, ConfigService } from '@nestjs/config'
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler'
import { ScheduleModule } from '@nestjs/schedule'
import { APP_GUARD } from '@nestjs/core'

import typeormRead from './orm/read'
import typeormWrite from './orm/write'

import { WalletModule } from './wallet/wallet.module'
import { PaymentModule } from './payment/payment.module'
import { SubscriptionModule } from './subscription/subscription.module'
import { InvoiceModule } from './invoice/invoice.module'
import { RefundModule } from './refund/refund.module'
import { BillingProfileModule } from './billing-profile/billing-profile.module'
import { PaymentMethodModule } from './payment-method/payment-method.module'
import { WebhookModule } from './webhook/webhook.module'
import { AuditModule } from './audit/audit.module'
import { TaxModule } from './tax/tax.module'
import { HealthModule } from './health/health.module'
import { TasksModule } from './tasks/tasks.module'
import { DianModule } from './dian/dian.module'
import { CheckoutModule } from './checkout/checkout.module'
import { BullModule } from '@nestjs/bullmq'
import { AdminModule } from './admin/admin.module'
import { MetricsModule } from './metrics/metrics.module'
import { EventBusModule } from './event-bus/event-bus.module'
import { ClientModule } from './client/client.module'
import { CreditModule } from './credit/credit.module'

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [typeormWrite, typeormRead],
    }),

    ThrottlerModule.forRoot([
      { name: 'short', ttl: 60000, limit: 100 },
      { name: 'medium', ttl: 60000, limit: 50 },
      { name: 'long', ttl: 900000, limit: 1000 },
    ]),

    ScheduleModule.forRoot(),

    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || '192.160.1.5',
        port: parseInt(process.env.REDIS_PORT || '6379'),
      },
    }),

    TypeOrmModule.forRootAsync({
      name: 'DBWrite',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        ...configService.get('typeormWrite'),
      }),
    }),

    TypeOrmModule.forRootAsync({
      name: 'DBRead',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        ...configService.get('typeormRead'),
      }),
    }),

    // Módulo global de clientes HTTP a otros servicios
    ClientModule,

    // Módulos de negocio
    WalletModule,
    PaymentModule,
    SubscriptionModule,
    InvoiceModule,
    RefundModule,
    BillingProfileModule,
    PaymentMethodModule,
    WebhookModule,
    AuditModule,
    TaxModule,
    HealthModule,
    TasksModule,
    DianModule,
    CheckoutModule,
    EventBusModule,
    AdminModule,
    MetricsModule,
    CreditModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
