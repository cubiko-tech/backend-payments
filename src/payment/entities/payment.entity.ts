import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum PaymentProvider {
  STRIPE = 'stripe',
  MERCADOPAGO = 'mercadopago',
  DROPI = 'dropi',
  WALLET = 'wallet',
  CONFIO = 'confio',
  // Paid with the Dropi balance; calls no provider and only its reported result closes it.
  DROPI_WALLET = 'dropi_wallet',
}
export enum PaymentStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  DISPUTED = 'disputed',
}
export enum PaymentPurpose {
  PLAN_PURCHASE = 'plan_purchase',
  WALLET_RECHARGE = 'wallet_recharge',
  SERVICE_PAYMENT = 'service_payment',
  TOKEN_PACKAGE = 'token_package',
  TOKEN_RECHARGE = 'token_recharge',
}

@Entity('payments')
@Index(['brandId', 'status', 'createdAt'])
@Index(['providerPaymentId'])
// One Dropi operation closes one recharge; only recharges carry `metadata.dropiRecharge`.
@Index('UQ_payments_dropi_operation', ['providerPaymentId'], {
  unique: true,
  where: `"providerPaymentId" IS NOT NULL AND "metadata" -> 'dropiRecharge' IS NOT NULL`,
})
@Index(['brandId', 'idempotencyKey'], { unique: true })
export class Payment extends Content {
  @Column() brandId: string
  @Column() userId: string
  @Column({ nullable: true }) idempotencyKey: string
  @Column({ type: 'uuid', nullable: true }) walletId: string
  @Column({ type: 'enum', enum: PaymentProvider }) provider: PaymentProvider
  @Column({ nullable: true }) providerPaymentId: string
  @Column({ type: 'decimal', precision: 15, scale: 2 }) amount: number
  @Column({ length: 3 }) currency: string
  // USD→COP TRM this payment was priced with, and the day it is valid from; null when unused.
  // pg returns a decimal as text: the transformer keeps the declared number type true.
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: { to: (value) => value, from: (value) => (value == null ? value : Number(value)) },
  })
  exchangeRate: number
  @Column({ type: 'date', nullable: true }) exchangeRateDate: string
  @Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING })
  status: PaymentStatus
  @Column({ type: 'enum', enum: PaymentPurpose }) purpose: PaymentPurpose
  @Column({ nullable: true }) purposeId: string
  @Column({ type: 'text', nullable: true }) checkoutUrl: string
  @Column({ type: 'text', nullable: true }) failureReason: string
  @Column({ type: 'timestamptz', nullable: true }) paidAt: Date
  @Column({ type: 'timestamptz', nullable: true }) expiresAt: Date
  @Column({ type: 'jsonb', nullable: true }) metadata: any
  // The invoice a recharge from Dropi went into; null until it is invoiced.
  @Column({ type: 'uuid', nullable: true }) invoiceId: string | null
}
