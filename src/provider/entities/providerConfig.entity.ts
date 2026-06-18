import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

/**
 * Configuración de proveedores de pago disponibles por país.
 * Permite controlar qué proveedores aparecen en el checkout según el país de la marca.
 */
@Entity('provider_config')
@Index(['country', 'provider'], { unique: true })
export class ProviderConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ length: 2, nullable: false })
  country: string

  @Column({ nullable: false })
  provider: string

  @Column({ default: true })
  isActive: boolean

  @Column({ type: 'int', default: 0 })
  priority: number

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
