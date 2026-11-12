import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AdminController } from './admin.controller'
import { Subscription } from '../subscription/entities/subscription.entity'
import { Payment } from '../payment/entities/payment.entity'
import { Wallet } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { ProviderConfig } from '../provider/entities/providerConfig.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { AuditModule } from '../audit/audit.module'
import { CreditModule } from '../credit/credit.module'
import { WalletModule } from '../wallet/wallet.module'
import { AdminTokenGiftController } from './admin-token-gift.controller'
import { AdminTokenPackageController } from './admin-token-package.controller'
import { AdminServiceCredentialController } from './admin-service-credential.controller'

@Module({
  imports: [
    TypeOrmModule.forFeature(
      [Subscription, Payment, Wallet, ProviderConfig, Transaction],
      'DBWrite',
    ),
    TypeOrmModule.forFeature(
      [Subscription, Payment, Wallet, WalletBalanceSnapshot, ProviderConfig, Transaction],
      'DBRead',
    ),
    AuditModule,
    CreditModule,
    WalletModule,
  ],
  controllers: [
    AdminController,
    AdminTokenGiftController,
    AdminTokenPackageController,
    AdminServiceCredentialController,
  ],
})
export class AdminModule {}
