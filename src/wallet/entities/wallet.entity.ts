import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

// Known provider values for callers; the DB column is varchar so new providers need no enum migration.
export enum WalletProvider {
  INTERNAL = 'internal',
  DROPI = 'dropi',
  STRIPE = 'stripe',
  MERCADOPAGO = 'mercadopago',
}
export enum WalletStatus {
  ACTIVE = 'active',
  FROZEN = 'frozen',
  CLOSED = 'closed',
}

@Entity('wallets')
@Index(['brandId', 'provider', 'currency'], { unique: true })
export class Wallet extends Content {
  @Column() brandId: string
  @Column() userId: string
  @Column({ type: 'varchar', length: 50 }) provider: string
  @Column({ nullable: true }) providerWalletId: string
  @Column({ length: 3 }) currency: string
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 }) balance: number
  @Column({ type: 'enum', enum: WalletStatus, default: WalletStatus.ACTIVE }) status: WalletStatus
  // Token balance by origin; only TKN wallets move them, and `balance` moves by the same amount.
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 }) giftTokens: number
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 }) purchasedTokens: number
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 }) dropiTokens: number
  @Column({ nullable: true }) label: string
  @Column({ type: 'jsonb', nullable: true }) metadata: any
}
