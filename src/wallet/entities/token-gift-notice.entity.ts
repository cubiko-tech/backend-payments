import { Column, Entity, Index } from 'typeorm'
import { Content } from '../../shared/entities/content.abstract'

export enum TokenGiftNoticeStatus {
  PENDIENTE = 'pendiente',
}

@Entity('token_gift_notices')
@Index('UQ_token_gift_notices_movement_key', ['movementKey'], { unique: true })
@Index('IDX_token_gift_notices_brand_status', ['brandId', 'status', 'createdAt'])
export class TokenGiftNotice extends Content {
  @Column({ type: 'varchar', length: 255 })
  brandId: string

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  amount: number

  @Column({ type: 'decimal', precision: 15, scale: 2 })
  balanceAfter: number

  @Column({ type: 'varchar', length: 255 })
  movementKey: string

  @Column({ type: 'varchar', length: 20, default: TokenGiftNoticeStatus.PENDIENTE })
  status: TokenGiftNoticeStatus
}
