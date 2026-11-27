import { Content } from '../../shared/entities/content.abstract'
import { Check, Column, Entity } from 'typeorm'

/** A token package a brand can buy: its USD price, the tokens it pays for and the bonus it adds. */
@Entity('token_packages')
@Check('CHK_token_packages_price_min', `"priceUsd" >= 10`)
@Check('CHK_token_packages_purchased', `"purchasedTokens" > 0`)
@Check('CHK_token_packages_bonus', `"bonusTokens" >= 0`)
export class TokenPackage extends Content {
  @Column({ length: 50, unique: true }) slug: string
  @Column({ length: 100 }) label: string
  @Column({ type: 'decimal', precision: 15, scale: 2 }) priceUsd: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) purchasedTokens: number
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 }) bonusTokens: number
  @Column({ default: true }) active: boolean
}
