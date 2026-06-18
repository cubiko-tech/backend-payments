import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { ProviderConfig } from './entities/providerConfig.entity'

@Injectable()
export class ProviderConfigService {
  private readonly logger = new Logger(ProviderConfigService.name)

  constructor(
    @InjectRepository(ProviderConfig, 'DBRead')
    private readonly configReadRepo: Repository<ProviderConfig>,
  ) {}

  /**
   * Obtener proveedores disponibles para un país, ordenados por prioridad.
   */
  async getAvailableProviders(country: string): Promise<string[]> {
    const configs = await this.configReadRepo.find({
      where: { country, isActive: true },
      order: { priority: 'ASC' },
    })

    return configs.map((c) => c.provider)
  }

  /**
   * Verificar si un proveedor está disponible para un país.
   */
  async isProviderAvailable(country: string, provider: string): Promise<boolean> {
    const config = await this.configReadRepo.findOne({
      where: { country, provider, isActive: true },
    })
    return !!config
  }

  /**
   * Listar toda la configuración (admin).
   */
  async findAll() {
    const configs = await this.configReadRepo.find({
      order: { country: 'ASC', priority: 'ASC' },
    })
    return { data: configs }
  }
}
