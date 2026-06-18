import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

/**
 * Precios enterprise personalizados por marca.
 * Cuando un brand con plan enterprise hace checkout,
 * se consulta esta tabla primero. Si existe, se usa este precio.
 * Si no, se usa el precio estándar de plan_prices en backend-roles.
 */
@Entity('enterprise_pricing')
@Index(['brandId'], { unique: true })
export class EnterprisePricing {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ nullable: false })
  brandId: string

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: false })
  monthlyPrice: number

  @Column({ length: 3, default: 'COP' })
  currency: string

  @Column({ nullable: true })
  negotiatedBy: string

  @Column({ type: 'timestamptz', nullable: true })
  validUntil: Date

  @Column({ type: 'text', nullable: true })
  notes: string

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
