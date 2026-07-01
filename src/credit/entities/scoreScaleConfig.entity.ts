import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'
import { ScaleConfig } from '../domain/scale-config.types'

export enum ScaleConfigStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  RETIRED = 'retired',
}

/**
 * Versión inmutable de la política de scoring (pesos, tramos, vetos, techos,
 * niveles). Cambiar la política crea una versión N+1; nunca se edita una
 * versión usada. Solo una `active` a la vez. Ver DISEÑO_SCORING_CREDITO §7.
 */
@Entity('credit_score_scale_config')
@Index(['version'], { unique: true })
export class ScoreScaleConfig extends Content {
  @Column({ type: 'int' })
  version: number

  @Column({ length: 5, default: 'COP' })
  baseCurrency: string

  @Column({ type: 'varchar', default: ScaleConfigStatus.DRAFT })
  status: ScaleConfigStatus

  @Column({ type: 'jsonb' })
  config: ScaleConfig

  @Column({ nullable: true })
  createdBy: string
}
