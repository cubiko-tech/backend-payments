import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, ManyToOne, JoinColumn, Index } from 'typeorm'
import { Wallet } from '../../wallet/entities/wallet.entity'

export enum TransactionType { CREDIT = 'credit', DEBIT = 'debit' }
export enum TransactionStatus { PENDING = 'pending', COMPLETED = 'completed', FAILED = 'failed', REVERSED = 'reversed' }

@Entity('transactions')
@Index(['walletId', 'createdAt'])
@Index(['brandId', 'createdAt'])
@Index(['referenceType', 'referenceId'])
export class Transaction extends Content {
  @Column('uuid') walletId: string
  @Column() brandId: string
  @Column({ type: 'enum', enum: TransactionType }) type: TransactionType
  @Column({ type: 'decimal', precision: 15, scale: 2 }) amount: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) balanceBefore: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) balanceAfter: number
  @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.COMPLETED }) status: TransactionStatus
  @Column({ nullable: true }) category: string
  @Column({ type: 'text', nullable: true }) description: string
  @Column({ nullable: true }) referenceType: string
  @Column({ nullable: true }) referenceId: string
  @Column({ type: 'jsonb', nullable: true }) metadata: any

  @ManyToOne(() => Wallet, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'walletId' })
  wallet: Wallet
}
