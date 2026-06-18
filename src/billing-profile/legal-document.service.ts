import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { BrandLegalDocument, DocumentStatus } from './entities/brandLegalDocument.entity'
import { RequestException } from '../shared/exception/request.exception'

@Injectable()
export class LegalDocumentService {
  private readonly logger = new Logger(LegalDocumentService.name)

  constructor(
    @InjectRepository(BrandLegalDocument, 'DBWrite')
    private readonly documentRepo: Repository<BrandLegalDocument>,
    @InjectRepository(BrandLegalDocument, 'DBRead')
    private readonly documentReadRepo: Repository<BrandLegalDocument>,
  ) {}

  /**
   * Listar documentos legales de una marca.
   */
  async findByBrand(brandId: string) {
    const documents = await this.documentReadRepo.find({
      where: { brandId },
      order: { createdAt: 'DESC' },
    })
    return { data: documents }
  }

  /**
   * Subir/actualizar un documento legal.
   * Si ya existe para ese tipo, se reemplaza.
   */
  async upsert(data: {
    brandId: string
    country: string
    documentType: string
    documentUrl: string
  }) {
    let document = await this.documentRepo.findOne({
      where: { brandId: data.brandId, documentType: data.documentType },
    })

    if (document) {
      document.documentUrl = data.documentUrl
      document.status = DocumentStatus.PENDING
      document.verifiedAt = null
      document.verifiedBy = null
      document.rejectionReason = null
    } else {
      document = this.documentRepo.create({
        brandId: data.brandId,
        country: data.country,
        documentType: data.documentType,
        documentUrl: data.documentUrl,
        status: DocumentStatus.PENDING,
      })
    }

    const saved = await this.documentRepo.save(document)
    this.logger.log(`Documento '${data.documentType}' subido para marca ${data.brandId}`)
    return { data: saved }
  }

  /**
   * Verificar un documento (admin).
   */
  async verify(documentId: string, verifiedBy: string) {
    const document = await this.documentRepo.findOne({ where: { id: documentId } })
    if (!document) {
      throw new RequestException(
        { code: 'DOCUMENT_NOT_FOUND', message: 'Documento no encontrado' },
        HttpStatus.NOT_FOUND,
      )
    }

    document.status = DocumentStatus.VERIFIED
    document.verifiedAt = new Date()
    document.verifiedBy = verifiedBy
    document.rejectionReason = null

    const saved = await this.documentRepo.save(document)
    this.logger.log(`Documento ${documentId} verificado por ${verifiedBy}`)
    return { data: saved }
  }

  /**
   * Rechazar un documento (admin).
   */
  async reject(documentId: string, verifiedBy: string, reason: string) {
    const document = await this.documentRepo.findOne({ where: { id: documentId } })
    if (!document) {
      throw new RequestException(
        { code: 'DOCUMENT_NOT_FOUND', message: 'Documento no encontrado' },
        HttpStatus.NOT_FOUND,
      )
    }

    document.status = DocumentStatus.REJECTED
    document.verifiedAt = new Date()
    document.verifiedBy = verifiedBy
    document.rejectionReason = reason

    const saved = await this.documentRepo.save(document)
    this.logger.log(`Documento ${documentId} rechazado por ${verifiedBy}: ${reason}`)
    return { data: saved }
  }

  /**
   * Listar todos los documentos con filtros y paginación (admin).
   */
  async findAll(filters: { status?: string; country?: string; documentType?: string; page?: number; perPage?: number }) {
    const p = Math.max(1, filters.page || 1)
    const limit = Math.min(100, Math.max(1, filters.perPage || 20))
    const skip = (p - 1) * limit

    const where: any = {}
    if (filters.status) where.status = filters.status
    if (filters.country) where.country = filters.country
    if (filters.documentType) where.documentType = filters.documentType

    const [documents, total] = await this.documentReadRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    })

    // Stats globales (sin paginación) para los conteos
    const allDocs = await this.documentReadRepo.find({ select: ['status'] })
    const byStatus: Record<string, number> = {}
    for (const d of allDocs) {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1
    }

    return { data: documents, count: total, meta: { page: p, perPage: limit, total, totalPages: Math.ceil(total / limit), byStatus } }
  }

  /**
   * Listar documentos pendientes de verificación (admin).
   */
  async findPending(limit = 50) {
    const documents = await this.documentReadRepo.find({
      where: { status: DocumentStatus.PENDING },
      order: { createdAt: 'ASC' },
      take: limit,
    })
    return { data: documents }
  }
}
