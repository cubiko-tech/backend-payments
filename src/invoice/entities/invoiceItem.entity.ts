import { Column, Entity, ManyToOne, JoinColumn, Index, PrimaryGeneratedColumn, CreateDateColumn } from 'typeorm'
import { Invoice } from './invoice.entity'

@Entity('invoice_items')
@Index(['invoiceId'])
export class InvoiceItem {
  @PrimaryGeneratedColumn('uuid') id: string
  @Column('uuid') invoiceId: string
  @Column({ type: 'text' }) description: string
  @Column({ type: 'int', default: 1 }) quantity: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) unitPrice: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) subtotal: number
  @Column({ type: 'decimal', precision: 5, scale: 4, default: 0 }) taxRate: number
  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0 }) taxAmount: number
  @Column({ type: 'decimal', precision: 15, scale: 2 }) total: number
  @Column({ nullable: true }) productType: string
  @Column({ nullable: true }) referenceType: string
  @Column({ nullable: true }) referenceId: string
  @CreateDateColumn({ type: 'timestamptz' }) createdAt: Date

  @ManyToOne(() => Invoice, (invoice) => invoice.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invoiceId' })
  invoice: Invoice
}
