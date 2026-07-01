import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'
import { BureauBand } from '../domain/scale-config.types'

/**
 * Resultado de una consulta de buró, keyed por DOCUMENTO legal (no por marca):
 * el resultado puede compartirse entre marcas del mismo titular. `band` es la
 * banda normalizada que consume el motor; los umbrales puntaje→banda son config
 * por provider. Caché con `validUntil`. Ver DISEÑO_SCORING_CREDITO §4.
 *
 * Fase 5 cablea los providers reales (manual/datacredito) + consentimiento
 * habeas data + RBAC. Aquí queda la tabla para que el snapshot pueda referenciarla.
 */
@Entity('credit_bureau_check')
@Index(['document', 'documentType', 'country'])
export class BureauCheck extends Content {
  @Column()
  provider: string

  @Column()
  document: string

  @Column()
  documentType: string

  @Column({ nullable: true })
  country: string

  @Column({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  rawScore: number

  @Column({ type: 'int', nullable: true })
  scaleMax: number

  @Column({ type: 'varchar', nullable: true })
  band: BureauBand

  @Column({ type: 'jsonb', nullable: true })
  raw: Record<string, any>

  @Column({ type: 'timestamptz', nullable: true })
  checkedAt: Date

  @Column({ type: 'timestamptz', nullable: true })
  validUntil: Date

  @Column({ nullable: true })
  createdBy: string
}
