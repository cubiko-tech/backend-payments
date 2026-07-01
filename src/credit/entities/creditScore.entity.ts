import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'
import { BureauBand } from '../domain/scale-config.types'
import {
  EligibilityStatus,
  SnapshotConditions,
  SnapshotInputs,
  SnapshotScoreStatus,
  SnapshotSubscores,
} from '../credit.types'

/**
 * Snapshot INMUTABLE de un score. Nunca se sobreescribe: cada cálculo crea una
 * fila. Auditabilidad como requisito: todo score histórico se reconstruye con su
 * snapshot (inputs crudos + fx con fecha + versión de escala + check de buró).
 *
 * Idempotencia del worker (Fase 3): único `(brandId, runId)` cuando hay run.
 * Ver DISEÑO_SCORING_CREDITO §7.
 */
@Entity('credit_score')
@Index(['brandId', 'createdAt'])
@Index(['brandId', 'runId'], { unique: true, where: '"runId" IS NOT NULL' })
export class CreditScore extends Content {
  @Column()
  brandId: string

  @Column({ type: 'uuid', nullable: true })
  runId: string | null

  @Column({ type: 'int' })
  scaleVersion: number

  // Período pedido vs efectivo (≠ ⇒ periodAdjusted).
  @Column({ type: 'date' })
  periodStart: string

  @Column({ type: 'date' })
  periodEnd: string

  @Column({ type: 'date' })
  effectiveStart: string

  @Column({ type: 'date' })
  effectiveEnd: string

  @Column({ default: false })
  periodAdjusted: boolean

  @Column({ type: 'jsonb' })
  inputs: SnapshotInputs

  @Column({ type: 'jsonb' })
  subscores: SnapshotSubscores

  @Column({ type: 'uuid', nullable: true })
  bureauCheckId: string | null

  @Column({ type: 'varchar', nullable: true })
  bureauBand: BureauBand | null

  @Column({ type: 'int' })
  total: number

  @Column({ nullable: true })
  tierByScore: string

  @Column({ nullable: true })
  tier: string

  @Column({ type: 'varchar', nullable: true })
  tierCappedBy: 'roas' | null

  @Column({ type: 'jsonb' })
  conditions: SnapshotConditions

  @Column({ type: 'varchar' })
  scoreStatus: SnapshotScoreStatus

  @Column({ type: 'varchar' })
  eligibilityStatus: EligibilityStatus

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  calculatedAt: Date

  @Column({ nullable: true })
  triggeredBy: string
}
