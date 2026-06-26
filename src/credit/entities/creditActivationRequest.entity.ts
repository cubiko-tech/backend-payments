import { Column, Entity, Index } from 'typeorm'

import { Content } from '../../shared/entities/content.abstract'
import { CreditActivationRequestSource, CreditActivationRequestStatus } from '../credit.types'

@Entity('credit_activation_request')
@Index(['brandId', 'createdAt'])
@Index(['brandId', 'status'])
export class CreditActivationRequest extends Content {
  @Column()
  brandId: string

  @Column({ type: 'uuid' })
  creditScoreId: string

  @Column({ type: 'int' })
  scoreTotal: number

  @Column({ type: 'varchar', nullable: true })
  tier: string | null

  @Column()
  fullName: string

  @Column()
  email: string

  @Column()
  phone: string

  @Column({ type: 'varchar', default: 'dropi' })
  source: CreditActivationRequestSource

  @Column({ type: 'varchar', default: 'pending' })
  status: CreditActivationRequestStatus

  @Column({ type: 'timestamptz', nullable: true })
  contactedAt: Date | null

  @Column({ nullable: true })
  contactedBy: string | null

  @Column({ type: 'text', nullable: true })
  notes: string | null
}
