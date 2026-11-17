import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { AuditModule } from '../audit/audit.module'
import { Transaction } from '../transaction/entities/transaction.entity'
import { TokenGiftBatch } from './entities/token-gift-batch.entity'
import { TokenGiftBatchItem } from './entities/token-gift-batch-item.entity'
import { TokenGiftNotice } from './entities/token-gift-notice.entity'
import { TokenPackage } from './entities/token-package.entity'
import { Wallet } from './entities/wallet.entity'
import { WalletBalanceSnapshot } from './entities/walletBalanceSnapshot.entity'
import { TokenDebitController } from './token-debit.controller'
import { TokenGiftBatchProcessor } from './token-gift-batch.processor'
import { TOKEN_GIFT_BATCH_QUEUE, TokenGiftBatchService } from './token-gift-batch.service'
import { TokenPackageController } from './token-package.controller'
import { TokenPackageService } from './token-package.service'
import { TokenWalletController } from './token-wallet.controller'
import { TokenWalletService } from './token-wallet.service'
import { WalletController } from './wallet.controller'
import { WalletService } from './wallet.service'

@Module({
  imports: [
    TypeOrmModule.forFeature(
      [
        Wallet,
        WalletBalanceSnapshot,
        Transaction,
        TokenPackage,
        TokenGiftBatch,
        TokenGiftBatchItem,
        TokenGiftNotice,
      ],
      'DBWrite',
    ),
    TypeOrmModule.forFeature(
      [Wallet, WalletBalanceSnapshot, Transaction, TokenGiftNotice],
      'DBRead',
    ),
    BullModule.registerQueue({ name: TOKEN_GIFT_BATCH_QUEUE }),
    AuditModule,
  ],
  controllers: [
    WalletController,
    TokenWalletController,
    TokenDebitController,
    TokenPackageController,
  ],
  providers: [
    WalletService,
    TokenWalletService,
    TokenPackageService,
    TokenGiftBatchService,
    TokenGiftBatchProcessor,
  ],
  exports: [WalletService, TokenWalletService, TokenPackageService, TokenGiftBatchService],
})
export class WalletModule {}
