import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, ManyToOne, JoinColumn, Index } from 'typeorm'
import { Payment } from './payment.entity'

export enum AttemptStatus { SUCCESS = 'success', FAILED = 'failed', TIMEOUT = 'timeout' }

@Entity('payment_attempts')
@Index(['paymentId', 'attemptNumber'])
export class PaymentAttempt extends Content {
  @Column('uuid') paymentId: string
  @Column({ type: 'int' }) attemptNumber: number
  @Column({ nullable: true }) provider: string
  @Column({ nullable: true }) providerResponseCode: string
  @Column({ type: 'text', nullable: true }) providerResponseMessage: string
  @Column({ type: 'enum', enum: AttemptStatus }) status: AttemptStatus
  @Column({ type: 'decimal', precision: 15, scale: 2 }) amount: number
  @Column({ type: 'jsonb', nullable: true }) metadata: any
  @Column({ type: 'timestamptz' }) attemptedAt: Date

  @ManyToOne(() => Payment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'paymentId' })
  payment: Payment
}
