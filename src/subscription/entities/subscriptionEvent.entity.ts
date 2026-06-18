import { Column, Entity, ManyToOne, JoinColumn, Index, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm'
import { Subscription } from './subscription.entity'

export enum SubscriptionEventType {
  CREATED = 'created', PLAN_CHANGED = 'plan_changed', RENEWED = 'renewed',
  CANCELLED = 'cancelled', EXPIRED = 'expired', REACTIVATED = 'reactivated',
  PAYMENT_FAILED = 'payment_failed', PAYMENT_SUCCEEDED = 'payment_succeeded',
  TRIAL_STARTED = 'trial_started', TRIAL_ENDED = 'trial_ended',
}

@Entity('subscription_events')
@Index(['subscriptionId', 'createdAt'])
@Index(['eventType', 'createdAt'])
export class SubscriptionEvent {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column('uuid') subscriptionId: string
  @Column({ type: 'enum', enum: SubscriptionEventType }) eventType: SubscriptionEventType
  @Column({ nullable: true }) fromPlanSlug: string
  @Column({ nullable: true }) toPlanSlug: string
  @Column({ nullable: true }) fromStatus: string
  @Column({ nullable: true }) toStatus: string
  @Column() triggeredBy: string
  @Column({ type: 'text', nullable: true }) reason: string
  @Column({ type: 'uuid', nullable: true }) paymentId: string
  @Column({ type: 'jsonb', nullable: true }) metadata: any
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date

  @ManyToOne(() => Subscription, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'subscriptionId' })
  subscription: Subscription
}
