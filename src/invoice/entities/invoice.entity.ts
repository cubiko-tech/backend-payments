import { Content } from '../../shared/entities/content.abstract'
import { Column, Entity, Index, OneToMany } from 'typeorm'
import { InvoiceItem } from './invoiceItem.entity'

export enum InvoiceType { INVOICE = 'invoice', CREDIT_NOTE = 'credit_note' }
export enum InvoiceStatus { DRAFT = 'draft', ISSUED = 'issued', PAID = 'paid', VOID = 'void' }

@Entity('invoices')
@Index(['brandId', 'createdAt'])
@Index(['invoiceNumber'], { unique: true })
export class Invoice extends Content {
  @Column() brandId: string
  @Column({ type: 'uuid', nullable: true }) paymentId: string
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
