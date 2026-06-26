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

@Module({
  imports: [
    TypeOrmModule.forFeature([Subscription, Payment, Wallet, ProviderConfig, Transaction], 'DBWrite'),
    TypeOrmModule.forFeature([Subscription, Payment, Wallet, WalletBalanceSnapshot, ProviderConfig, Transaction], 'DBRead'),
    AuditModule,
    CreditModule,
  ],
  controllers: [AdminController],
})
export class AdminModule {}
