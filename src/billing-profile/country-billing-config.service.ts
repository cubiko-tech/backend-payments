import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { CountryBillingConfig } from './entities/countryBillingConfig.entity'

@Injectable()
export class CountryBillingConfigService {
  private readonly logger = new Logger(CountryBillingConfigService.name)

  // Caché en memoria — los datos de país cambian muy poco
  private cache = new Map<string, CountryBillingConfig>()
  private cacheLoaded = false

  constructor(
    @InjectRepository(CountryBillingConfig, 'DBRead')
    private readonly configRepo: Repository<CountryBillingConfig>,
  ) {}

  /**
   * Obtener configuración para un país específico.
   */
  async getForCountry(country: string): Promise<CountryBillingConfig | null> {
    if (!this.cacheLoaded) await this.loadCache()
    return this.cache.get(country) || null
  }

  /**
   * Obtener campos requeridos para el billing profile de un país.
   */
  async getRequiredFields(country: string): Promise<string[]> {
    const config = await this.getForCountry(country)
    return config?.requiredFields || ['legalName', 'country', 'email']
  }

  /**
   * Verificar si un país requiere facturación electrónica.
   */
  async requiresElectronicInvoice(country: string): Promise<boolean> {
    const config = await this.getForCountry(country)
    return config?.electronicInvoiceRequired || false
  }

  /**
   * Obtener el provider de facturación electrónica para un país.
   */
  async getElectronicInvoiceProvider(country: string): Promise<string | null> {
    const config = await this.getForCountry(country)
    return config?.electronicInvoiceProvider || null
  }

  /**
   * Obtener documentos legales requeridos para un país.
   */
  async getRequiredDocuments(country: string): Promise<string[]> {
    const config = await this.getForCountry(country)
    return config?.legalDocuments || []
  }

  /**
   * Listar todas las configuraciones (admin).
   */
  async findAll() {
    const configs = await this.configRepo.find({ order: { country: 'ASC' } })
    return { data: configs }
  }

  /**
   * Validar un billing profile contra los requisitos del país.
   * Retorna lista de errores (vacía si todo OK).
   */
  async validateBillingProfile(country: string, profile: Record<string, any>): Promise<string[]> {
    const config = await this.getForCountry(country)
    if (!config) return [] // País sin configuración → no validar

    const errors: string[] = []

    // Validar campos requeridos
    for (const field of config.requiredFields) {
      if (!profile[field] || (typeof profile[field] === 'string' && profile[field].trim() === '')) {
        errors.push(`Campo '${field}' es requerido para ${config.countryName}`)
      }
    }

    // Validar tipo de documento fiscal
    if (config.taxIdRequired && profile.taxIdType) {
      if (!config.taxIdTypes.includes(profile.taxIdType)) {
        errors.push(`Tipo de documento '${profile.taxIdType}' no válido para ${config.countryName}. Válidos: ${config.taxIdTypes.join(', ')}`)
      }
    }

    // Validar régimen fiscal
    if (config.taxRegimeRequired && profile.taxRegime) {
      if (!config.taxRegimes.includes(profile.taxRegime)) {
        errors.push(`Régimen fiscal '${profile.taxRegime}' no válido para ${config.countryName}. Válidos: ${config.taxRegimes.join(', ')}`)
      }
    }

    return errors
  }

  private async loadCache() {
    const configs = await this.configRepo.find({ where: { isActive: true } })
    this.cache.clear()
    for (const config of configs) {
      this.cache.set(config.country, config)
    }
    this.cacheLoaded = true
    this.logger.log(`Caché de country billing config cargado: ${configs.length} países`)
  }
}
