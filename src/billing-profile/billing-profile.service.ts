import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { BillingProfile } from './entities/billingProfile.entity'
import { CountryBillingConfigService } from './country-billing-config.service'
import { RequestException } from '../shared/exception/request.exception'

@Injectable()
export class BillingProfileService {
  private readonly logger = new Logger(BillingProfileService.name)

  constructor(
    @InjectRepository(BillingProfile, 'DBWrite')
    private readonly billingProfileRepository: Repository<BillingProfile>,
    @InjectRepository(BillingProfile, 'DBRead')
    private readonly billingProfileReadRepository: Repository<BillingProfile>,
    private readonly countryConfig: CountryBillingConfigService,
  ) {}

  /**
   * Obtener perfil de facturación de una marca
   */
  async get(brandId: string) {
    try {
      const profile = await this.billingProfileReadRepository.findOne({
        where: { brandId },
      })
      if (!profile) {
        throw new RequestException(
          { code: 'BILLING_PROFILE_NOT_FOUND', message: 'Perfil de facturación no encontrado' },
          HttpStatus.NOT_FOUND,
        )
      }
      return { data: profile }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(
        `Error al obtener perfil de facturación de marca ${brandId}: ${error.message}`,
      )
      return { error: error.message }
    }
  }

  /**
   * Obtener requisitos de facturación para un país.
   */
  async getRequirements(country: string) {
    const config = await this.countryConfig.getForCountry(country)
    if (!config) {
      return {
        data: { country, requiredFields: ['legalName', 'country', 'email'], legalDocuments: [] },
      }
    }
    return {
      data: {
        country: config.country,
        countryName: config.countryName,
        requiredFields: config.requiredFields,
        taxIdTypes: config.taxIdTypes,
        taxRegimes: config.taxRegimes,
        taxIdRequired: config.taxIdRequired,
        taxRegimeRequired: config.taxRegimeRequired,
        legalDocuments: config.legalDocuments,
        electronicInvoiceRequired: config.electronicInvoiceRequired,
      },
    }
  }

  /**
   * Crear perfil de facturación con validación por país.
   */
  async create(data: Partial<BillingProfile>) {
    try {
      const sanitized: Partial<BillingProfile> = {
        ...this.pickAllowedFields(data),
        brandId: data.brandId,
      }

      // Validar campos según país
      if (sanitized.country) {
        const errors = await this.countryConfig.validateBillingProfile(
          sanitized.country,
          sanitized as any,
        )
        if (errors.length > 0) {
          throw new RequestException(
            { code: 'VALIDATION_ERROR', message: errors.join('; ') },
            HttpStatus.UNPROCESSABLE_ENTITY,
          )
        }
      }

      const profile = this.billingProfileRepository.create(sanitized)
      const saved = await this.billingProfileRepository.save(profile)
      this.logger.log(`Perfil de facturación creado: ${saved.id} para marca ${saved.brandId}`)
      return { data: saved }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al crear perfil de facturación: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Actualizar perfil de facturación con validación por país.
   */
  async update(brandId: string, data: Partial<BillingProfile>) {
    try {
      const profile = await this.billingProfileRepository.findOne({
        where: { brandId },
      })
      if (!profile) {
        throw new RequestException(
          { code: 'BILLING_PROFILE_NOT_FOUND', message: 'Perfil de facturación no encontrado' },
          HttpStatus.NOT_FOUND,
        )
      }

      const sanitized = this.pickAllowedFields(data)

      // Merge y validar contra el país
      const merged = { ...profile, ...sanitized, brandId }
      const country = merged.country || profile.country
      if (country) {
        const errors = await this.countryConfig.validateBillingProfile(country, merged as any)
        if (errors.length > 0) {
          throw new RequestException(
            { code: 'VALIDATION_ERROR', message: errors.join('; ') },
            HttpStatus.UNPROCESSABLE_ENTITY,
          )
        }
      }

      Object.assign(profile, sanitized)
      profile.brandId = brandId
      const saved = await this.billingProfileRepository.save(profile)

      this.logger.log(`Perfil de facturación actualizado para marca ${brandId}`)
      return { data: saved }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(
        `Error al actualizar perfil de facturación de marca ${brandId}: ${error.message}`,
      )
      return { error: error.message }
    }
  }

  private pickAllowedFields(data: Partial<BillingProfile>): Partial<BillingProfile> {
    const allowedKeys: ReadonlyArray<keyof BillingProfile> = [
      'legalName',
      'taxId',
      'taxIdType',
      'address',
      'city',
      'state',
      'country',
      'postalCode',
      'email',
      'phone',
      'taxRegime',
      'dianResolutionNumber',
      'dianResolutionPrefix',
      'dianResolutionRangeFrom',
      'dianResolutionRangeTo',
      'dianResolutionDate',
      'dianResolutionExpiry',
    ]

    const result: Partial<BillingProfile> = {}
    for (const key of allowedKeys) {
      if (data && data[key] !== undefined) {
        ;(result as Record<string, unknown>)[key] = data[key]
      }
    }
    return result
  }
}
