import {
  Column,
  Entity,
  ForeignKey,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm'
import { Wallet } from './wallet.entity'

@Entity('wallet_balance_snapshots')
@Index('IDX_wallet_snapshots_wallet_date', ['walletId', 'snapshotAt'])
@Index('IDX_wallet_snapshots_inconsistent', ['isConsistent'], { where: `"isConsistent" = false` })
export class WalletBalanceSnapshot {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column('uuid')
  @ForeignKey(() => Wallet, { name: 'FK_wallet_snapshots_wallet', onDelete: 'CASCADE' })
  walletId: string
  @Column({ type: 'decimal', precision: 15, scale: 2 }) balance: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) calculatedBalance: number
  @Column({ type: 'int' }) transactionCount: number
  @Column() isConsistent: boolean
  @Column({ type: 'timestamptz' }) snapshotAt: Date
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date
}
