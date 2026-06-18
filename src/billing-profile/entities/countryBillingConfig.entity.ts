import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm'

/**
 * Configuración de requisitos de facturación y legales por país.
 * Define qué campos son obligatorios, qué documentos legales se piden,
 * qué proveedor de facturación electrónica se usa, y más.
 */
@Entity('country_billing_config')
@Index(['country'], { unique: true })
export class CountryBillingConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ length: 2, nullable: false })
  country: string

  @Column({ nullable: false })
  countryName: string

  // --- Requisitos de identificación fiscal ---

  @Column({ default: false })
  taxIdRequired: boolean

  @Column({ type: 'jsonb', default: '[]' })
  taxIdTypes: string[]                     // ["NIT","CC","CE"] para CO, ["RFC"] para MX

  @Column({ default: false })
  taxRegimeRequired: boolean

  @Column({ type: 'jsonb', default: '[]' })
  taxRegimes: string[]                     // ["responsable_iva","no_responsable","gran_contribuyente"]

  // --- Facturación electrónica ---

  @Column({ default: false })
  electronicInvoiceRequired: boolean

  @Column({ nullable: true })
  electronicInvoiceProvider: string        // "siigo" | "alegra" | "sat" | null

  // --- Campos obligatorios del billing profile ---

  @Column({ type: 'jsonb', default: '[]' })
  requiredFields: string[]                 // ["legalName","taxId","address","city","email"]

  // --- Documentos legales requeridos ---

  @Column({ type: 'jsonb', default: '[]' })
  legalDocuments: string[]                 // ["rut","camara_comercio"] para CO

  // --- Formato de factura ---

  @Column({ nullable: true })
  invoicePrefix: string

  @Column({ nullable: true })
  invoiceFormat: string                    // "PREFIX-YYYY-NNNNNN"

  @Column({ default: true })
  isActive: boolean

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date
}
