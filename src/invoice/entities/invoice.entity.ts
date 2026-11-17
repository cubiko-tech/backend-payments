import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index, OneToMany } from 'typeorm'
import { InvoiceItem } from './invoiceItem.entity'

export enum InvoiceType {
  INVOICE = 'invoice',
  CREDIT_NOTE = 'credit_note',
}
export enum InvoiceStatus {
  DRAFT = 'draft',
  ISSUED = 'issued',
  PAID = 'paid',
  VOID = 'void',
}

/** `metadata` flag of a credit note due at the DIAN: written before sending, gone once accepted. */
export const DIAN_PENDING_FLAG = 'dianPending'

/** `metadata` key holding when a send to the DIAN was claimed: present only while it runs. */
export const DIAN_SENDING_FLAG = 'dianSendingAt'

@Entity('invoices')
@Index(['brandId', 'createdAt'])
@Index(['invoiceNumber'], { unique: true })
@Index('UQ_invoices_payment_id', ['paymentId'], { unique: true })
// One consolidated recharge invoice per brand and month.
@Index('UQ_invoices_brand_period', ['brandId', 'period'], {
  unique: true,
  where: `"period" IS NOT NULL`,
})
export class Invoice extends Content {
  @Column() brandId: string
  @Column({ type: 'uuid', nullable: true }) paymentId: string
  // `YYYY-MM` in America/Bogota of a monthly recharge invoice; null on every other invoice.
  @Column({ type: 'varchar', length: 7, nullable: true }) period: string | null
  @Column({ type: 'uuid', nullable: true }) subscriptionId: string
  @Column({ type: 'uuid', nullable: true }) billingProfileId: string
  @Column({ type: 'enum', enum: InvoiceType, default: InvoiceType.INVOICE }) type: InvoiceType
  @Column({ type: 'uuid', nullable: true }) creditNoteForId: string
  @Column({ unique: true }) invoiceNumber: string
  @Column({ type: 'decimal', precision: 15, scale: 2 }) subtotal: number
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 }) taxTotal: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) total: number
  @Column({ length: 3 }) currency: string
  @Column({ type: 'enum', enum: InvoiceStatus, default: InvoiceStatus.DRAFT }) status: InvoiceStatus
  @Column({ type: 'timestamptz', nullable: true }) issuedAt: Date
  @Column({ type: 'timestamptz', nullable: true }) paidAt: Date
  @Column({ type: 'timestamptz', nullable: true }) dueAt: Date
  @Column({ nullable: true }) dianCufe: string
  @Column({ nullable: true }) pdfUrl: string
  @Column({ type: 'jsonb', nullable: true }) metadata: any

  @OneToMany(() => InvoiceItem, (item) => item.invoice, { cascade: true })
  items: InvoiceItem[]
}
