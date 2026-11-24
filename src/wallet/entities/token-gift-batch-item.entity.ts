import { Column, Entity, ForeignKey, Index, Unique } from 'typeorm'
import { Content } from '../../shared/entities/content.abstract'
import { TokenGiftBatch } from './token-gift-batch.entity'

export enum GiftBatchItemOutcome {
  PENDING = 'pending',
  ACREDITADA = 'acreditada',
  REPETIDA = 'repetida',
  OMITIDA = 'omitida',
}

export enum GiftBatchOmitReason {
  SIN_WALLET = 'sin_wallet',
  CERRADA = 'cerrada',
  MARCA_INEXISTENTE = 'marca_inexistente',
  // Values must fit the varchar(20) `omitReason` column.
  BRAND_LOOKUP_UNAVAILABLE = 'lookup_unavailable',
}

@Entity('token_gift_batch_items')
@Unique('UQ_token_gift_batch_items_batch_brand', ['batchId', 'brandId'])
@Index('IDX_token_gift_batch_items_batch_outcome_seq', ['batchId', 'outcome', 'seq'])
@Index('IDX_token_gift_batch_items_batch_seq', ['batchId', 'seq'])
export class TokenGiftBatchItem extends Content {
  @Column({ type: 'uuid' })
  @ForeignKey(() => TokenGiftBatch, {
    name: 'FK_token_gift_batch_items_batch',
    onDelete: 'CASCADE',
  })
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
