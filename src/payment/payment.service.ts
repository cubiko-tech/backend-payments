import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource, Not } from 'typeorm'
import { Payment, PaymentProvider, PaymentStatus } from './entities/payment.entity'
import { PaymentAttempt } from './entities/paymentAttempt.entity'
import { WalletService } from '../wallet/wallet.service'
import { RequestException } from '../shared/exception/request.exception'
import { Transaction } from '../transaction/entities/transaction.entity'
import { lockPayment } from './payment-lock'

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name)

  constructor(
    @InjectRepository(Payment, 'DBWrite')
    private readonly paymentRepository: Repository<Payment>,
    @InjectRepository(Payment, 'DBRead')
    private readonly paymentReadRepository: Repository<Payment>,
    @InjectRepository(PaymentAttempt, 'DBWrite')
    private readonly paymentAttemptRepository: Repository<PaymentAttempt>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
    private readonly walletService: WalletService,
  ) {}

  /**
   * Obtener un pago por ID
   */
  async getPaymentById(id: string) {
    try {
      const payment = await this.paymentReadRepository.findOne({ where: { id } })
      if (!payment) {
        throw new RequestException(
          { code: 'PAYMENT_NOT_FOUND', message: 'Pago no encontrado' },
          HttpStatus.NOT_FOUND,
        )
      }
      return { data: payment }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al obtener pago ${id}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Listar pagos de una marca con paginación
   */
  async getPaymentsByBrand(
    brandId: string,
    filters: { page?: number; limit?: number; status?: string } = {},
  ) {
    try {
      const { page = 1, limit = 20, status } = filters
      const skip = (page - 1) * limit

      const where: any = { brandId }
      if (status) where.status = status

      const [payments, total] = await this.paymentReadRepository.findAndCount({
        where,
        order: { createdAt: 'DESC' },
        skip,
        take: limit,
      })

      return {
        data: payments,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      }
    } catch (error) {
      this.logger.error(`Error al listar pagos de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Cancelar un pago pendiente
   */
  async cancelPayment(id: string) {
    const runner = this.dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      await lockPayment(runner, id)
      const payment = await runner.manager.findOne(Payment, { where: { id } })
      if (!payment) {
        throw new RequestException(
          { code: 'PAYMENT_NOT_FOUND', message: 'Pago no encontrado' },
          HttpStatus.NOT_FOUND,
        )
      }

      const debit = await runner.manager.findOne(Transaction, {
        where: { idempotencyKey: `payment:${id}:debit` },
      })
      const failureReason = 'Cancelado por el usuario'
      const cancelled = debit
        ? null
        : await runner.manager.update(
            Payment,
            // A recharge from Dropi may be charging at Dropi right now: only its result closes it.
            { id, status: PaymentStatus.PENDING, provider: Not(PaymentProvider.DROPI_WALLET) },
            { status: PaymentStatus.FAILED, failureReason },
          )
      if (!cancelled?.affected) {
        throw new RequestException(
          { code: 'PAYMENT_NOT_CANCELLABLE', message: 'Solo se pueden cancelar pagos pendientes' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      await runner.commitTransaction()

      this.logger.log(`Pago cancelado: ${id}`)
      return { data: { ...payment, status: PaymentStatus.FAILED, failureReason } }
    } catch (error) {
      if (runner.isTransactionActive) {
        await runner.rollbackTransaction()
      }
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al cancelar pago ${id}: ${error.message}`)
      return { error: error.message }
    } finally {
      await runner.release()
    }
  }
}
