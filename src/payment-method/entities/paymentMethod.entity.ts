import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum PaymentMethodType { CARD = 'card', BANK_TRANSFER = 'bank_transfer', PSE = 'pse', NEQUI = 'nequi', WALLET = 'wallet' }
export enum PaymentMethodStatus { ACTIVE = 'active', EXPIRED = 'expired', REMOVED = 'removed' }

@Entity('payment_methods')
@Index(['brandId', 'isDefault'])
export class PaymentMethod extends Content {
  @Column() brandId: string
  @Column() userId: string
  @Column() provider: string
  @Column() providerMethodId: string
  @Column({ type: 'enum', enum: PaymentMethodType }) type: PaymentMethodType
  @Column({ length: 4, nullable: true }) last4: string
  @Column({ nullable: true }) brand: string
  @Column({ type: 'int', nullable: true }) expiryMonth: number
  @Column({ type: 'int', nullable: true }) expiryYear: number
  @Column({ default: false }) isDefault: boolean
  @Column({ type: 'enum', enum: PaymentMethodStatus, default: PaymentMethodStatus.ACTIVE }) status: PaymentMethodStatus
  @Column({ type: 'jsonb', nullable: true }) metadata: any
}
