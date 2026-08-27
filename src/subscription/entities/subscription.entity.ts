import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum SubscriptionStatus { TRIAL = 'trial', ACTIVE = 'active', PAST_DUE = 'past_due', CANCELLED = 'cancelled', EXPIRED = 'expired' }
export enum SubscriptionProvider { STRIPE = 'stripe', MERCADOPAGO = 'mercadopago', WALLET = 'wallet', DROPI = 'dropi', CONFIO = 'confio' }

@Entity('subscriptions')
@Index(['brandId'], { unique: true })
@Index(['status', 'nextBillingDate'])
export class Subscription extends Content {
  @Column() brandId: string
  @Column() userId: string
  @Column() planSlug: string
  @Column({ type: 'enum', enum: SubscriptionStatus, default: SubscriptionStatus.TRIAL }) status: SubscriptionStatus
  @Column({ type: 'uuid', nullable: true }) walletId: string
  @Column({ type: 'enum', enum: SubscriptionProvider }) provider: SubscriptionProvider
  @Column({ nullable: true }) providerSubscriptionId: string
  @Column({ type: 'timestamptz' }) currentPeriodStart: Date
  @Column({ type: 'timestamptz' }) currentPeriodEnd: Date
  @Column({ type: 'timestamptz', nullable: true }) trialStart: Date
  @Column({ type: 'timestamptz', nullable: true }) trialEnd: Date
  @Column({ default: true }) autoRenew: boolean
  // El link inicial del alta (el `acceptanceUrl` de ConfioPagos) ya fue emitido para ESTA fila: el cron
  // de conversión no debe emitir un segundo. Columna propia y no `metadata.confio` (jsonb no es un
  // marcador explícito) ni `providerSubscriptionId` (ese es criterio de backfill de una sola vez).
  @Column({ type: 'timestamptz', nullable: true }) initialPaymentLinkIssuedAt: Date
  @Column({ type: 'timestamptz', nullable: true }) cancelledAt: Date
  @Column({ type: 'text', nullable: true }) cancelReason: string
  @Column({ type: 'uuid', nullable: true }) lastPaymentId: string
  @Column({ type: 'timestamptz', nullable: true }) nextBillingDate: Date
  @Column({ type: 'int', default: 0 }) retryCount: number
  @Column({ type: 'jsonb', nullable: true }) metadata: any
}
