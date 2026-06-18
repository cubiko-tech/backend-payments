import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { EnterprisePricing } from './entities/enterprisePricing.entity'

@Injectable()
export class EnterprisePricingService {
  private readonly logger = new Logger(EnterprisePricingService.name)

  constructor(
    @InjectRepository(EnterprisePricing, 'DBWrite')
    private readonly pricingRepo: Repository<EnterprisePricing>,
    @InjectRepository(EnterprisePricing, 'DBRead')
    private readonly pricingReadRepo: Repository<EnterprisePricing>,
  ) {}

  /**
   * Obtener precio enterprise personalizado para una marca.
   * Retorna null si no hay precio personalizado o si expiró.
   */
  async getForBrand(brandId: string): Promise<EnterprisePricing | null> {
    const pricing = await this.pricingReadRepo.findOne({ where: { brandId } })
    if (!pricing) return null

    // Si tiene fecha de validez y ya expiró, retornar null
    if (pricing.validUntil && pricing.validUntil < new Date()) {
      return null
    }

    return pricing
  }

  /**
   * Listar todos los precios enterprise personalizados.
   */
  async findAll() {
    const items = await this.pricingReadRepo.find({ order: { createdAt: 'DESC' } })
    return { data: items }
  }

  /**
   * Crear o actualizar precio enterprise para una marca.
   */
  async upsert(brandId: string, data: {
    monthlyPrice: number
    currency?: string
    negotiatedBy?: string
    validUntil?: Date
    notes?: string
  }) {
    let pricing = await this.pricingRepo.findOne({ where: { brandId } })

    if (pricing) {
      pricing.monthlyPrice = data.monthlyPrice
      if (data.currency) pricing.currency = data.currency
      if (data.negotiatedBy) pricing.negotiatedBy = data.negotiatedBy
      if (data.validUntil) pricing.validUntil = data.validUntil
      if (data.notes !== undefined) pricing.notes = data.notes
    } else {
      pricing = this.pricingRepo.create({
        brandId,
        monthlyPrice: data.monthlyPrice,
        currency: data.currency || 'COP',
        negotiatedBy: data.negotiatedBy,
        validUntil: data.validUntil,
        notes: data.notes,
      })
    }

    const saved = await this.pricingRepo.save(pricing)
    this.logger.log(`Precio enterprise actualizado para marca ${brandId}: ${data.monthlyPrice} ${data.currency || 'COP'}`)
    return { data: saved }
  }

  /**
   * Eliminar precio enterprise (volver a precio estándar).
   */
  async remove(brandId: string) {
    const pricing = await this.pricingRepo.findOne({ where: { brandId } })
    if (!pricing) {
      return { data: { success: false, message: 'No se encontró precio personalizado' } }
    }

    await this.pricingRepo.delete({ id: pricing.id })
    this.logger.log(`Precio enterprise eliminado para marca ${brandId}`)
    return { data: { success: true } }
  }
}
