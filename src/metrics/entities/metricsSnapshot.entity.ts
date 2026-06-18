import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm'

/**
 * Snapshots diarios de métricas para gráficas históricas.
 * Se generan via cron y evitan recalcular sobre toda la BD.
 */
@Entity('metrics_snapshots')
@Index(['date', 'type'], { unique: true })
export class MetricsSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'date', nullable: false })
  date: string

  @Column({ nullable: false })
  type: string                // "daily_summary", "mrr", "churn", "subscribers"

  @Column({ type: 'jsonb', nullable: false })
  data: Record<string, any>

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date
}
