import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'
import { Invoice, InvoiceType, InvoiceStatus } from './entities/invoice.entity'
import { InvoiceItem } from './entities/invoiceItem.entity'
import { RequestException } from '../shared/exception/request.exception'

@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name)

  constructor(
    @InjectRepository(Invoice, 'DBWrite')
    private readonly invoiceRepository: Repository<Invoice>,
    @InjectRepository(Invoice, 'DBRead')
    private readonly invoiceReadRepository: Repository<Invoice>,
    @InjectRepository(InvoiceItem, 'DBWrite')
    private readonly invoiceItemRepository: Repository<InvoiceItem>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Crear una factura con sus ítems
   */
  async create(data: Partial<Invoice> & { items?: Partial<InvoiceItem>[] }) {
    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()

    try {
      const { items, ...invoiceData } = data
      const invoice = queryRunner.manager.create(Invoice, invoiceData)
      const savedInvoice = await queryRunner.manager.save(Invoice, invoice)

      if (items && items.length > 0) {
        const invoiceItems = items.map((item) =>
          queryRunner.manager.create(InvoiceItem, {
            ...item,
            invoiceId: savedInvoice.id,
          }),
        )
        await queryRunner.manager.save(InvoiceItem, invoiceItems)
      }

      await queryRunner.commitTransaction()

      // Recargar con relaciones
      const result = await this.invoiceReadRepository.findOne({
        where: { id: savedInvoice.id },
        relations: ['items'],
      })

      this.logger.log(`Factura creada: ${savedInvoice.id} (${savedInvoice.invoiceNumber})`)
      return { data: result }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      this.logger.error(`Error al crear factura: ${error.message}`)
      return { error: error.message }
    } finally {
      await queryRunner.release()
    }
  }

  /**
   * Listar facturas de una marca
   */
  async findByBrand(brandId: string, filters: { page?: number; limit?: number; type?: string } = {}) {
    try {
      const { page = 1, limit = 20, type } = filters
      const skip = (page - 1) * limit

      const where: any = { brandId }
      if (type) where.type = type

      const [invoices, total] = await this.invoiceReadRepository.findAndCount({
        where,
        relations: ['items'],
        order: { createdAt: 'DESC' },
        skip,
        take: limit,
      })

      return {
        data: invoices,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      }
    } catch (error) {
      this.logger.error(`Error al listar facturas de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Obtener factura por ID
   */
  async findById(id: string) {
    try {
      const invoice = await this.invoiceReadRepository.findOne({
        where: { id },
        relations: ['items'],
      })
      if (!invoice) {
        throw new RequestException(
          { code: 'INVOICE_NOT_FOUND', message: 'Factura no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }
      return { data: invoice }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al obtener factura ${id}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Crear nota crédito asociada a una factura y un reembolso
   */
  async createCreditNote(invoiceId: string, refundId: string) {
    try {
      const originalInvoice = await this.invoiceReadRepository.findOne({
        where: { id: invoiceId },
        relations: ['items'],
      })

      if (!originalInvoice) {
        throw new RequestException(
          { code: 'INVOICE_NOT_FOUND', message: 'Factura original no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      // Generar número de nota crédito
      const creditNoteNumber = `NC-${originalInvoice.invoiceNumber}`

      const creditNote = this.invoiceRepository.create({
        brandId: originalInvoice.brandId,
        paymentId: originalInvoice.paymentId,
        subscriptionId: originalInvoice.subscriptionId,
        billingProfileId: originalInvoice.billingProfileId,
        type: InvoiceType.CREDIT_NOTE,
        creditNoteForId: invoiceId,
        invoiceNumber: creditNoteNumber,
        subtotal: originalInvoice.subtotal,
        taxTotal: originalInvoice.taxTotal,
        total: originalInvoice.total,
        currency: originalInvoice.currency,
        status: InvoiceStatus.ISSUED,
        issuedAt: new Date(),
        metadata: { refundId },
      })
      const saved = await this.invoiceRepository.save(creditNote)

      this.logger.log(`Nota crédito creada: ${saved.id} para factura ${invoiceId}`)
      return { data: saved }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al crear nota crédito para factura ${invoiceId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Obtener notas crédito de una factura
   */
  async findCreditNotes(invoiceId: string) {
    try {
      const creditNotes = await this.invoiceReadRepository.find({
        where: { creditNoteForId: invoiceId, type: InvoiceType.CREDIT_NOTE },
        order: { createdAt: 'DESC' },
      })
      return { data: creditNotes }
    } catch (error) {
      this.logger.error(`Error al obtener notas crédito de factura ${invoiceId}: ${error.message}`)
      return { error: error.message }
    }
  }
}
