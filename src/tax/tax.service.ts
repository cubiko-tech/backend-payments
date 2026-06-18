import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { TaxConfig } from './entities/taxConfig.entity'

@Injectable()
export class TaxService {
  private readonly logger = new Logger(TaxService.name)

  constructor(
    @InjectRepository(TaxConfig, 'DBRead')
    private readonly taxConfigReadRepository: Repository<TaxConfig>,
  ) {}

  /**
   * Obtener configuración de impuestos por país.
   * Uso interno — no expone controller.
   */
  async getTaxForCountry(country: string): Promise<{ taxName: string; taxRate: number; isInclusive: boolean }> {
    try {
      const config = await this.taxConfigReadRepository.findOne({
        where: { country: country.toUpperCase(), isActive: true },
      })

      if (!config) {
        this.logger.warn(`No se encontró configuración de impuestos para ${country}, usando 0%`)
        return { taxName: 'N/A', taxRate: 0, isInclusive: false }
      }

      return {
        taxName: config.taxName,
        taxRate: Number(config.taxRate),
        isInclusive: config.isInclusive,
      }
    } catch (error) {
      this.logger.error(`Error al obtener impuestos para ${country}: ${error.message}`)
      return { taxName: 'N/A', taxRate: 0, isInclusive: false }
    }
  }
}
