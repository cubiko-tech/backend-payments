import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum CreditProfileStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
}

/**
 * Perfil de crédito por marca: documento legal del titular + constancia de
 * consentimiento habeas data (Leyes 1266/1581). NINGUNA consulta de buró se
 * ejecuta sin consentimiento vigente registrado (regla dura, validada en el
 * service en Fase 5). Ver DISEÑO_SCORING_CREDITO §4.
 */
@Entity('credit_profile')
@Index(['brandId'], { unique: true })
export class CreditProfile extends Content {
  @Column()
  brandId: string

  @Column({ nullable: true })
  document: string

  @Column({ nullable: true })
  documentType: string

  @Column({ nullable: true })
  country: string

  @Column({ type: 'timestamptz', nullable: true })
  consentGrantedAt: Date

  @Column({ nullable: true })
  consentVersion: string

  @Column({ nullable: true })
  consentSource: string

  @Column({ type: 'varchar', default: CreditProfileStatus.ACTIVE })
  status: CreditProfileStatus
}
