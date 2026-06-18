import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index } from 'typeorm'

export enum TaxIdType { NIT = 'NIT', CC = 'CC', CE = 'CE', RFC = 'RFC', RUC = 'RUC', PASSPORT = 'PASSPORT' }
export enum TaxRegime { RESPONSABLE_IVA = 'responsable_iva', NO_RESPONSABLE = 'no_responsable', GRAN_CONTRIBUYENTE = 'gran_contribuyente', SIMPLIFICADO = 'simplificado' }

@Entity('billing_profiles')
@Index(['brandId'], { unique: true })
export class BillingProfile extends Content {
  @Column({ unique: true }) brandId: string
  @Column() legalName: string
  @Column() taxId: string
  @Column({ type: 'enum', enum: TaxIdType }) taxIdType: TaxIdType
  @Column({ nullable: true }) address: string
  @Column({ nullable: true }) city: string
  @Column({ nullable: true }) state: string
  @Column({ length: 2 }) country: string
  @Column({ nullable: true }) postalCode: string
  @Column() email: string
  @Column({ nullable: true }) phone: string
  @Column({ type: 'enum', enum: TaxRegime, nullable: true }) taxRegime: TaxRegime
  @Column({ nullable: true }) dianResolutionNumber: string
  @Column({ nullable: true }) dianResolutionPrefix: string
  @Column({ type: 'int', nullable: true }) dianResolutionRangeFrom: number
  @Column({ type: 'int', nullable: true }) dianResolutionRangeTo: number
  @Column({ type: 'date', nullable: true }) dianResolutionDate: Date
  @Column({ type: 'date', nullable: true }) dianResolutionExpiry: Date
}
