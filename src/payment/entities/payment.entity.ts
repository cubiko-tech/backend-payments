import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum PaymentProvider { STRIPE = 'stripe', MERCADOPAGO = 'mercadopago', DROPI = 'dropi', WALLET = 'wallet' }
export enum PaymentStatus { PENDING = 'pending', PROCESSING = 'processing', COMPLETED = 'completed', FAILED = 'failed', REFUNDED = 'refunded', DISPUTED = 'disputed' }
export enum PaymentPurpose { PLAN_PURCHASE = 'plan_purchase', WALLET_RECHARGE = 'wallet_recharge', SERVICE_PAYMENT = 'service_payment' }

@Entity('payments')
@Index(['brandId', 'status', 'createdAt'])
@Index(['providerPaymentId'])
export class Payment extends Content {
  @Column() brandId: string
  @Column() userId: string
  @Column({ type: 'uuid', nullable: true }) walletId: string
  @Column({ type: 'enum', enum: PaymentProvider }) provider: PaymentProvider
  @Column({ nullable: true }) providerPaymentId: string
  @Column({ type: 'decimal', precision: 15, scale: 2 }) amount: number
  @Column({ length: 3 }) currency: string
  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING }) status: PaymentStatus
  @Column({ type: 'enum', enum: PaymentPurpose }) purpose: PaymentPurpose
  @Column({ nullable: true }) purposeId: string
  @Column({ type: 'text', nullable: true }) checkoutUrl: string
  @Column({ type: 'text', nullable: true }) failureReason: string
  @Column({ type: 'timestamptz', nullable: true }) paidAt: Date
  @Column({ type: 'timestamptz', nullable: true }) expiresAt: Date
  @Column({ type: 'jsonb', nullable: true }) metadata: any
}
