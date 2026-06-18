import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum RefundReason { CUSTOMER_REQUEST = 'customer_request', DUPLICATE = 'duplicate', DISPUTE = 'dispute', SERVICE_ISSUE = 'service_issue', PLAN_DOWNGRADE = 'plan_downgrade' }
export enum RefundStatus { PENDING = 'pending', PROCESSING = 'processing', COMPLETED = 'completed', FAILED = 'failed' }

@Entity('refunds')
@Index(['paymentId'])
@Index(['brandId', 'createdAt'])
export class Refund extends Content {
  @Column('uuid') paymentId: string
  @Column() brandId: string
  @Column({ type: 'decimal', precision: 15, scale: 2 }) amount: number
  @Column({ length: 3 }) currency: string
  @Column({ type: 'enum', enum: RefundReason }) reason: RefundReason
  @Column({ type: 'enum', enum: RefundStatus, default: RefundStatus.PENDING }) status: RefundStatus
  @Column({ nullable: true }) provider: string
  @Column({ nullable: true }) providerRefundId: string
  @Column({ type: 'uuid', nullable: true }) creditNoteId: string
  @Column() requestedBy: string
  @Column({ nullable: true }) approvedBy: string
  @Column({ type: 'text', nullable: true }) description: string
  @Column({ type: 'jsonb', nullable: true }) metadata: any
  @Column({ type: 'timestamptz', nullable: true }) processedAt: Date
}
