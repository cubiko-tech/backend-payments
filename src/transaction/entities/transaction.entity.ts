import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, ManyToOne, JoinColumn, Index } from 'typeorm'
import { Wallet } from '../../wallet/entities/wallet.entity'

export enum TransactionType {
  CREDIT = 'credit',
  DEBIT = 'debit',
}
export enum TransactionStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REVERSED = 'reversed',
}

/**
 * What `transactions.metadata` holds: the marks payments reads back, plus whatever context the writer of
 * the movement attached (an admin adjustment, a recharge), which is why it stays open.
 */
export interface TransactionMetadata {
  // Tokens per origin, as `token-spend.ts` stores it.
  tokenSplit?: { gift?: unknown; purchased?: unknown; dropi?: unknown }
  debitId?: string
  cycleExtension?: 'pending' | 'extended' | 'refunded'
  giftBatchId?: string
  cycleNumber?: number
  providerSubscriptionId?: string
  [key: string]: unknown
}

@Entity('transactions')
@Index('IDX_transactions_wallet_date', ['walletId', 'createdAt'])
@Index('IDX_transactions_brand_date', ['brandId', 'createdAt'])
@Index('IDX_transactions_reference', ['referenceType', 'referenceId'])
export class Transaction extends Content {
  @Column('uuid') walletId: string
  @Column() brandId: string
  @Column({ type: 'enum', enum: TransactionType, enumName: 'transaction_type_enum' })
  type: TransactionType
  @Column({ type: 'decimal', precision: 15, scale: 2 }) amount: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) balanceBefore: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) balanceAfter: number
  @Column({
    type: 'enum',
    enum: TransactionStatus,
    enumName: 'transaction_status_enum',
    default: TransactionStatus.COMPLETED,
  })
  status: TransactionStatus
  @Column({ nullable: true }) category: string
  @Column({ type: 'text', nullable: true }) description: string
  @Column({ nullable: true }) referenceType: string
  @Column({ nullable: true }) referenceId: string
  @Column({ nullable: true, unique: true }) idempotencyKey: string
  @Column({ type: 'varchar', length: 20, nullable: true }) tokenOrigin: string | null
  @Column({ type: 'jsonb', nullable: true }) metadata: TransactionMetadata

  @ManyToOne(() => Wallet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'walletId', foreignKeyConstraintName: 'FK_transactions_wallet' })
  wallet: Wallet
}
