import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Invoice } from './entities/invoice.entity'
import { InvoiceItem } from './entities/invoiceItem.entity'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { TaxConfig } from '../tax/entities/taxConfig.entity'
import { logger } from '../shared/logger/logger'

/**
 * Servicio de generación de facturas en PDF.
 * Usa PDFKit para generar documentos sin dependencias externas.
 */
@Injectable()
export class InvoicePdfService {
  constructor(
    @InjectRepository(Invoice, 'DBRead')
    private invoiceRepo: Repository<Invoice>,
    @InjectRepository(BillingProfile, 'DBRead')
    private billingProfileRepo: Repository<BillingProfile>,
  ) {}

  /**
   * Genera un PDF de factura y retorna el Buffer.
   */
  async generatePdf(invoiceId: string): Promise<Buffer> {
    const invoice = await this.invoiceRepo.findOne({
      where: { id: invoiceId },
      relations: ['items'],
    })

    if (!invoice) {
      throw new Error('Factura no encontrada')
    }

    const billingProfile = invoice.billingProfileId
      ? await this.billingProfileRepo.findOne({ where: { id: invoice.billingProfileId } })
      : null

    return this.buildPdf(invoice, billingProfile)
  }

  /**
   * Construye el documento PDF con PDFKit.
   */
  private buildPdf(invoice: Invoice, profile: BillingProfile | null): Promise<Buffer> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const PDFDocument = require('pdfkit')

    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'LETTER',
        margin: 50,
        info: {
          Title: `Factura ${invoice.invoiceNumber}`,
          Author: 'Cubiko',
        },
      })

      const chunks: Buffer[] = []
      doc.on('data', (chunk: Buffer) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      // =============================================
      // Encabezado
      // =============================================
      doc
        .fontSize(20)
        .font('Helvetica-Bold')
        .text('CUBIKO', 50, 50)

      doc
        .fontSize(10)
        .font('Helvetica')
        .text('cubiko.co', 50, 75)
        .text('admin@cubiko.co', 50, 88)

      // Tipo de documento
      const docTitle = invoice.type === 'credit_note'
        ? 'NOTA CRÉDITO'
        : 'FACTURA DE VENTA'

      doc
        .fontSize(16)
        .font('Helvetica-Bold')
        .text(docTitle, 350, 50, { align: 'right' })

      doc
        .fontSize(10)
        .font('Helvetica')
        .text(`No. ${invoice.invoiceNumber}`, 350, 75, { align: 'right' })

      // Fechas
      doc
        .text(`Fecha emisión: ${this.formatDate(invoice.issuedAt || invoice.createdAt)}`, 350, 90, { align: 'right' })

      if (invoice.dueAt) {
        doc.text(`Fecha vencimiento: ${this.formatDate(invoice.dueAt)}`, 350, 103, { align: 'right' })
      }

      if (invoice.dianCufe) {
        doc
          .fontSize(7)
          .text(`CUFE: ${invoice.dianCufe}`, 350, 118, { align: 'right' })
      }

      // Línea separadora
      doc
        .moveTo(50, 140)
        .lineTo(562, 140)
        .stroke()

      // =============================================
      // Datos del cliente
      // =============================================
      let yPos = 155

      doc
        .fontSize(10)
        .font('Helvetica-Bold')
        .text('DATOS DEL CLIENTE', 50, yPos)

      yPos += 18

      if (profile) {
        doc.font('Helvetica').fontSize(9)
        doc.text(`Razón social: ${profile.legalName}`, 50, yPos)
        yPos += 14
        doc.text(`${profile.taxIdType}: ${profile.taxId}`, 50, yPos)
        yPos += 14
        if (profile.address) {
          doc.text(`Dirección: ${profile.address}${profile.city ? `, ${profile.city}` : ''}${profile.state ? `, ${profile.state}` : ''}`, 50, yPos)
          yPos += 14
        }
        if (profile.email) {
          doc.text(`Email: ${profile.email}`, 50, yPos)
          yPos += 14
        }
        if (profile.phone) {
          doc.text(`Teléfono: ${profile.phone}`, 50, yPos)
          yPos += 14
        }
        if (profile.taxRegime) {
          const regimes = {
            responsable_iva: 'Responsable de IVA',
            no_responsable: 'No responsable de IVA',
            gran_contribuyente: 'Gran contribuyente',
            simplificado: 'Régimen simplificado',
          }
          doc.text(`Régimen: ${regimes[profile.taxRegime] || profile.taxRegime}`, 50, yPos)
          yPos += 14
        }
      } else {
        doc.font('Helvetica').fontSize(9)
        doc.text(`Marca: ${invoice.brandId}`, 50, yPos)
        yPos += 14
      }

      // Nota crédito referencia
      if (invoice.type === 'credit_note' && invoice.creditNoteForId) {
        yPos += 5
        doc.font('Helvetica-Bold').fontSize(9)
        doc.text(`Nota crédito para factura: ${invoice.creditNoteForId}`, 50, yPos)
        yPos += 14
      }

      yPos += 10

      // =============================================
      // Tabla de items
      // =============================================
      const tableTop = yPos
      const colX = {
        description: 50,
        qty: 300,
        unitPrice: 350,
        tax: 430,
        total: 490,
      }

      // Header de tabla
      doc
        .font('Helvetica-Bold')
        .fontSize(9)
        .fillColor('#333333')

      doc.rect(50, tableTop, 512, 20).fill('#f0f0f0')
      doc.fillColor('#333333')

      doc.text('Descripción', colX.description + 5, tableTop + 5)
      doc.text('Cant.', colX.qty, tableTop + 5)
      doc.text('Precio', colX.unitPrice, tableTop + 5)
      doc.text('Impuesto', colX.tax, tableTop + 5)
      doc.text('Total', colX.total, tableTop + 5)

      yPos = tableTop + 25

      // Rows de items
      doc.font('Helvetica').fontSize(9).fillColor('#000000')

      const items = invoice.items || []
      for (const item of items) {
        if (yPos > 680) {
          doc.addPage()
          yPos = 50
        }

        doc.text(item.description, colX.description + 5, yPos, { width: 240 })
        doc.text(String(item.quantity), colX.qty, yPos)
        doc.text(this.formatMoney(item.unitPrice, invoice.currency), colX.unitPrice, yPos)
        doc.text(item.taxRate > 0 ? `${(item.taxRate * 100).toFixed(0)}%` : '-', colX.tax, yPos)
        doc.text(this.formatMoney(item.total, invoice.currency), colX.total, yPos)

        yPos += 18

        // Línea sutil
        doc.moveTo(50, yPos - 3).lineTo(562, yPos - 3).strokeColor('#eeeeee').stroke()
      }

      // =============================================
      // Totales
      // =============================================
      yPos += 15

      doc.strokeColor('#333333')
      doc.moveTo(350, yPos).lineTo(562, yPos).stroke()
      yPos += 10

      doc.font('Helvetica').fontSize(10)
      doc.text('Subtotal:', 350, yPos)
      doc.text(this.formatMoney(invoice.subtotal, invoice.currency), 490, yPos, { align: 'right', width: 72 })
      yPos += 18

      if (invoice.taxTotal > 0) {
        doc.text('Impuestos:', 350, yPos)
        doc.text(this.formatMoney(invoice.taxTotal, invoice.currency), 490, yPos, { align: 'right', width: 72 })
        yPos += 18
      }

      doc.font('Helvetica-Bold').fontSize(12)
      doc.text('TOTAL:', 350, yPos)
      doc.text(this.formatMoney(invoice.total, invoice.currency), 490, yPos, { align: 'right', width: 72 })
      yPos += 25

      // Estado
      const statusLabels = {
        draft: 'BORRADOR',
        issued: 'EMITIDA',
        paid: 'PAGADA',
        void: 'ANULADA',
      }

      const statusColors = {
        draft: '#999999',
        issued: '#ff9900',
        paid: '#00aa00',
        void: '#cc0000',
      }

      doc
        .font('Helvetica-Bold')
        .fontSize(14)
        .fillColor(statusColors[invoice.status] || '#333333')
        .text(statusLabels[invoice.status] || invoice.status.toUpperCase(), 350, yPos, { align: 'right' })

      // =============================================
      // Footer
      // =============================================
      const footerY = doc.page.height - 80

      doc
        .fillColor('#999999')
        .fontSize(8)
        .font('Helvetica')
        .text('Documento generado automáticamente por Cubiko.', 50, footerY, { align: 'center' })
        .text('cubiko.co | admin@cubiko.co', 50, footerY + 12, { align: 'center' })

      if (invoice.dianCufe) {
        doc.text('Factura electrónica válida ante la DIAN', 50, footerY + 24, { align: 'center' })
      }

      doc.end()
    })
  }

  // =============================================
  // Helpers
  // =============================================

  private formatDate(date: Date | string): string {
    const d = date instanceof Date ? date : new Date(date)
    return d.toLocaleDateString('es-CO', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }

  private formatMoney(amount: number | string, currency: string): string {
    const num = typeof amount === 'string' ? parseFloat(amount) : amount
    const formatted = num.toLocaleString('es-CO', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })

    const symbols = { COP: '$', USD: 'US$', MXN: 'MX$' }
    return `${symbols[currency] || currency} ${formatted}`
  }
}
