import { Column, Entity, Index } from 'typeorm'
import { Content } from '../../shared/entities/content.abstract'

export enum GiftBatchItemOutcome {
  PENDING = 'pending',
  ACREDITADA = 'acreditada',
  REPETIDA = 'repetida',
  OMITIDA = 'omitida',
}

export enum GiftBatchOmitReason {
  SIN_WALLET = 'sin_wallet',
  CERRADA = 'cerrada',
}

@Entity('token_gift_batch_items')
@Index('UQ_token_gift_batch_items_batch_brand', ['batchId', 'brandId'], { unique: true })
@Index('IDX_token_gift_batch_items_batch_outcome_seq', ['batchId', 'outcome', 'seq'])
@Index('IDX_token_gift_batch_items_batch_seq', ['batchId', 'seq'])
export class TokenGiftBatchItem extends Content {
  @Column({ type: 'uuid' })
  batchId: string

  @Column({ type: 'int' })
  seq: number

  @Column({ type: 'varchar', length: 255 })
  brandId: string

  @Column({ type: 'uuid', nullable: true })
  walletId: string | null

  @Column({ type: 'varchar', length: 20, default: GiftBatchItemOutcome.PENDING })
  outcome: GiftBatchItemOutcome

  @Column({ type: 'varchar', length: 20, nullable: true })
  omitReason: GiftBatchOmitReason | null

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 })
  creditedAmount: number

  @Column({ type: 'uuid', nullable: true })
  transactionId: string | null
}
