import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum WebhookStatus {
  RECEIVED = 'received',
  PROCESSING = 'processing',
  PROCESSED = 'processed',
  FAILED = 'failed',
}

@Entity('webhook_events')
@Index('UQ_webhook_events_provider_event', ['provider', 'providerEventId'], { unique: true })
@Index(['status'])
export class WebhookEvent extends Content {
  @Column() provider: string
  @Column() eventType: string
  @Column() providerEventId: string
  @Column({ type: 'jsonb' }) payload: any
  @Column({ type: 'enum', enum: WebhookStatus, default: WebhookStatus.RECEIVED })
  status: WebhookStatus
  @Column({ type: 'timestamptz', nullable: true }) processedAt: Date
  @Column({ type: 'text', nullable: true }) error: string
  @Column({ type: 'int', default: 0 }) retryCount: number
}
