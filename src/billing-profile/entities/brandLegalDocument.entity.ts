import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

export enum DocumentStatus {
  PENDING = 'pending',
  VERIFIED = 'verified',
  REJECTED = 'rejected',
}

/**
 * Documentos legales subidos por marca.
 * Cada país requiere documentos diferentes (RUT, Cámara de Comercio, RFC, etc.)
 */
@Entity('brand_legal_documents')
@Index(['brandId', 'documentType'], { unique: true })
export class BrandLegalDocument {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ nullable: false })
  brandId: string

  @Column({ length: 2, nullable: false })
  country: string

  @Column({ nullable: false })
  documentType: string                 // "rut", "camara_comercio", "constancia_situacion_fiscal"

  @Column({ nullable: false })
  documentUrl: string                  // URL del archivo subido (S3/GCS)

  @Column({ type: 'enum', enum: DocumentStatus, default: DocumentStatus.PENDING })
  status: DocumentStatus

  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt: Date

  @Column({ nullable: true })
  verifiedBy: string                   // userId del admin que verificó

  @Column({ type: 'text', nullable: true })
  rejectionReason: string

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
