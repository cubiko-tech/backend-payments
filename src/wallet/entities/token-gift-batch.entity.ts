import { Column, Entity, Index } from 'typeorm'
import { Content } from '../../shared/entities/content.abstract'

export enum GiftBatchStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('token_gift_batches')
@Index('UQ_token_gift_batches_idempotency_key', ['idempotencyKey'], { unique: true })
export class TokenGiftBatch extends Content {
  @Column({ type: 'varchar', length: 200 })
  idempotencyKey: string

  @Column({ type: 'varchar', length: 20 })
  filterKind: 'all_open' | 'brands'

  @Column({ type: 'jsonb', nullable: true })
  filterBrandIds: string[] | null

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount: number

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  confirmedTotalTokens: number

  @Column({ type: 'varchar', length: 500 })
  reason: string

  @Column({ type: 'varchar', length: 255 })
  authorId: string

  @Column({ type: 'varchar', length: 20, default: GiftBatchStatus.PENDING })
  status: GiftBatchStatus

  @Column({ type: 'int', default: 0 })
  totalBrands: number

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null
}
