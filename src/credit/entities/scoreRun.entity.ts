import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum ScoreRunStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Run masivo de scoring para un período (Fase 3). La ejecución vive en una cola
 * BullMQ durable; esta fila da progreso/polling. Los contadores se derivan de los
 * snapshots `credit_score` del run (no son la única fuente de verdad), salvo
 * `errors`, que cuenta marcas que no llegaron a snapshot.
 *
 * Guard de unicidad: un solo run `pending|running` por `(periodStart, periodEnd)`
 * (índice parcial único en la migración). Ver DISEÑO_SCORING_CREDITO §6.3, §7.
 */
@Entity('score_run')
@Index(['periodStart', 'periodEnd'])
export class ScoreRun extends Content {
  @Column({ type: 'date' })
  periodStart: string

  @Column({ type: 'date' })
  periodEnd: string

  @Column({ type: 'varchar', default: ScoreRunStatus.PENDING })
  status: ScoreRunStatus

  @Column({ type: 'int', default: 0 })
  totalBrands: number

  @Column({ type: 'int', default: 0 })
  processed: number

  @Column({ type: 'int', default: 0 })
  eligible: number

  @Column({ type: 'int', default: 0 })
  vetoed: number

  @Column({ type: 'int', default: 0 })
  insufficient: number

  @Column({ type: 'int', default: 0 })
  errors: number

  @Column({ nullable: true })
  triggeredBy: string

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null
}
