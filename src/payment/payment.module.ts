import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Payment } from './entities/payment.entity'
import { PaymentAttempt } from './entities/paymentAttempt.entity'
import { ProviderConfig } from '../provider/entities/providerConfig.entity'
import { PaymentController } from './payment.controller'
import { PaymentService } from './payment.service'
import { WalletModule } from '../wallet/wallet.module'
import { ProviderFactory } from '../provider/provider.factory'
import { ProviderConfigService } from '../provider/provider-config.service'
import { StripeProvider } from '../provider/stripe/stripe.provider'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { DropiProvider } from '../provider/dropi/dropi.provider'
import { ConfioProvider } from '../provider/confio/confio.provider'

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, PaymentAttempt], 'DBWrite'),
    TypeOrmModule.forFeature([Payment, PaymentAttempt, ProviderConfig], 'DBRead'),
    WalletModule,
  ],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    ProviderFactory,
    ProviderConfigService,
    StripeProvider,
    MercadoPagoProvider,
    DropiProvider,
    ConfioProvider,
  ],
  exports: [PaymentService, ProviderFactory, ProviderConfigService, StripeProvider, MercadoPagoProvider, DropiProvider, ConfioProvider],
})
export class PaymentModule {}
