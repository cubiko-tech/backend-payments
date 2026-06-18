import { Column, Entity, Index, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm'

@Entity('wallet_balance_snapshots')
@Index(['walletId', 'snapshotAt'])
export class WalletBalanceSnapshot {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column('uuid') walletId: string
  @Column({ type: 'decimal', precision: 15, scale: 2 }) balance: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) calculatedBalance: number
  @Column({ type: 'int' }) transactionCount: number
  @Column() isConsistent: boolean
  @Column({ type: 'timestamptz' }) snapshotAt: Date
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date
}
