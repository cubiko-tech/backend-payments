import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity } from 'typeorm'

/** A token package a brand can buy: its USD price, the tokens it pays for and the bonus it adds. */
@Entity('token_packages')
export class TokenPackage extends Content {
  @Column({ length: 50, unique: true }) slug: string
  @Column({ length: 100 }) label: string
  @Column({ type: 'decimal', precision: 15, scale: 2 }) priceUsd: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) purchasedTokens: number
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 }) bonusTokens: number
  @Column({ default: true }) active: boolean
}
