import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

// Mantenemos el enum para referencia en código existente, pero la columna es varchar
export enum WalletProvider { INTERNAL = 'internal', DROPI = 'dropi', STRIPE = 'stripe', MERCADOPAGO = 'mercadopago' }
export enum WalletStatus { ACTIVE = 'active', FROZEN = 'frozen', CLOSED = 'closed' }

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
  @Column({ nullable: true }) label: string
  @Column({ type: 'jsonb', nullable: true }) metadata: any
}
