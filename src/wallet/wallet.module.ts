import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Wallet } from './entities/wallet.entity'
import { WalletBalanceSnapshot } from './entities/walletBalanceSnapshot.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { WalletController } from './wallet.controller'
import { WalletService } from './wallet.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([Wallet, WalletBalanceSnapshot, Transaction], 'DBWrite'),
    TypeOrmModule.forFeature([Wallet, WalletBalanceSnapshot, Transaction], 'DBRead'),
  ],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
