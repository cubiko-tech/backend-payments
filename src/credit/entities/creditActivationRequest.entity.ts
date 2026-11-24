import { Column, Entity, ForeignKey, Index } from 'typeorm'

import { Content } from '../../shared/entities/content.abstract'
import { CreditActivationRequestSource, CreditActivationRequestStatus } from '../credit.types'
import { CreditScore } from './creditScore.entity'

@Entity('credit_activation_request')
@Index('IDX_credit_activation_request_brand_created', ['brandId', 'createdAt'])
@Index('IDX_credit_activation_request_brand_status', ['brandId', 'status'])
@Index('UQ_credit_activation_request_open_brand', ['brandId'], {
  unique: true,
  where: `"status" IN ('pending', 'contacted', 'qualified')`,
})
export class CreditActivationRequest extends Content {
  @Column()
  brandId: string

  @Column({ type: 'uuid' })
  @ForeignKey(() => CreditScore, { name: 'FK_credit_activation_request_score' })
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

  /** Usuario que originó la solicitud (id del token); null si la creó el sistema. */
  @Column({ nullable: true })
  requestedBy: string | null

  @Column({ type: 'timestamptz', nullable: true })
  contactedAt: Date | null

  @Column({ nullable: true })
  contactedBy: string | null

  @Column({ type: 'text', nullable: true })
  notes: string | null
}
