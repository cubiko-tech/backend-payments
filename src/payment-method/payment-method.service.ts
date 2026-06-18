import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'
import { PaymentMethod, PaymentMethodStatus } from './entities/paymentMethod.entity'
import { RequestException } from '../shared/exception/request.exception'

@Injectable()
export class PaymentMethodService {
  private readonly logger = new Logger(PaymentMethodService.name)

  constructor(
    @InjectRepository(PaymentMethod, 'DBWrite')
    private readonly paymentMethodRepository: Repository<PaymentMethod>,
    @InjectRepository(PaymentMethod, 'DBRead')
    private readonly paymentMethodReadRepository: Repository<PaymentMethod>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Listar métodos de pago de una marca
   */
  async findByBrand(brandId: string) {
    try {
      const methods = await this.paymentMethodReadRepository.find({
        where: { brandId, status: PaymentMethodStatus.ACTIVE },
        order: { isDefault: 'DESC', createdAt: 'DESC' },
      })
      return { data: methods }
    } catch (error) {
      this.logger.error(`Error al listar métodos de pago de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Crear un método de pago
   */
  async create(data: Partial<PaymentMethod>) {
    try {
      const method = this.paymentMethodRepository.create(data)
      const saved = await this.paymentMethodRepository.save(method)
      this.logger.log(`Método de pago creado: ${saved.id} para marca ${saved.brandId}`)
      return { data: saved }
    } catch (error) {
      this.logger.error(`Error al crear método de pago: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Eliminar (soft) un método de pago
   */
  async remove(id: string) {
    try {
      const method = await this.paymentMethodRepository.findOne({ where: { id } })
      if (!method) {
        throw new RequestException(
          { code: 'PAYMENT_METHOD_NOT_FOUND', message: 'Método de pago no encontrado' },
          HttpStatus.NOT_FOUND,
        )
      }

      if (method.isDefault) {
        throw new RequestException(
          { code: 'CANNOT_REMOVE_DEFAULT', message: 'No se puede eliminar el método de pago por defecto' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      method.status = PaymentMethodStatus.REMOVED
      const saved = await this.paymentMethodRepository.save(method)

      this.logger.log(`Método de pago eliminado: ${id}`)
      return { data: saved }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al eliminar método de pago ${id}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Establecer un método de pago como predeterminado.
   * Desactiva el flag isDefault de los demás métodos de la marca.
   */
  async setDefault(id: string) {
    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()

    try {
      const method = await queryRunner.manager.findOne(PaymentMethod, { where: { id } })
      if (!method) {
        throw new RequestException(
          { code: 'PAYMENT_METHOD_NOT_FOUND', message: 'Método de pago no encontrado' },
          HttpStatus.NOT_FOUND,
        )
      }

      // Quitar default de todos los métodos de la marca
      await queryRunner.manager.update(PaymentMethod, { brandId: method.brandId }, { isDefault: false })

      // Establecer este como default
      method.isDefault = true
      await queryRunner.manager.save(PaymentMethod, method)

      await queryRunner.commitTransaction()

      this.logger.log(`Método de pago ${id} establecido como predeterminado para marca ${method.brandId}`)
      return { data: method }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al establecer método de pago como predeterminado ${id}: ${error.message}`)
      return { error: error.message }
    } finally {
      await queryRunner.release()
    }
  }
}
