import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

@Entity('tax_config')
@Index(['country'], { unique: true })
export class TaxConfig extends Content {
  @Column({ length: 2 }) country: string
  @Column() taxName: string
  @Column({ type: 'decimal', precision: 5, scale: 4 }) taxRate: number
  @Column({ default: false }) isInclusive: boolean
  @Column({ default: true }) isActive: boolean
}
