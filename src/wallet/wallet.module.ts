import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Wallet } from './entities/wallet.entity'
import { WalletBalanceSnapshot } from './entities/walletBalanceSnapshot.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { WalletController } from './wallet.controller'
import { WalletService } from './wallet.service'
import { TokenWalletController } from './token-wallet.controller'
import { TokenWalletService } from './token-wallet.service'
import { TokenDebitController } from './token-debit.controller'
import { TokenPackage } from './entities/token-package.entity'
import { TokenPackageController } from './token-package.controller'
import { TokenPackageService } from './token-package.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([Wallet, WalletBalanceSnapshot, Transaction, TokenPackage], 'DBWrite'),
    TypeOrmModule.forFeature([Wallet, WalletBalanceSnapshot, Transaction], 'DBRead'),
  ],
  controllers: [
    WalletController,
    TokenWalletController,
    TokenDebitController,
    TokenPackageController,
  ],
  providers: [WalletService, TokenWalletService, TokenPackageService],
  exports: [WalletService, TokenWalletService, TokenPackageService],
})
export class WalletModule {}
