import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { Refund, RefundStatus } from './entities/refund.entity'
import { RequestException } from '../shared/exception/request.exception'

@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name)

  constructor(
    @InjectRepository(Refund, 'DBWrite')
    private readonly refundRepository: Repository<Refund>,
    @InjectRepository(Refund, 'DBRead')
    private readonly refundReadRepository: Repository<Refund>,
    @InjectRepository(Payment, 'DBRead')
    private readonly paymentReadRepository: Repository<Payment>,
  ) {}

  /**
   * Solicitar un reembolso
   */
  async request(data: Partial<Refund>) {
    try {
      const saved =
        typeof this.refundRepository.manager?.transaction === 'function'
          ? await this.refundRepository.manager.transaction((manager) =>
              this.createPendingRefund(
                data,
                (id) =>
                  manager.findOne(Payment, {
                    where: { id },
                    lock: { mode: 'pessimistic_write' },
                  }),
                manager.getRepository(Refund),
              ),
            )
          : await this.createPendingRefund(
              data,
              (id) => this.paymentReadRepository.findOne({ where: { id } }),
              this.refundRepository,
            )
      this.logger.log(`Reembolso solicitado: ${saved.id} para pago ${saved.paymentId}`)
      return { data: saved }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al solicitar reembolso: ${error.message}`)
      return { error: error.message }
    }
  }

  private async createPendingRefund(
    data: Partial<Refund>,
    findPayment: (id: string) => Promise<Payment | null>,
    refundRepo: Pick<Repository<Refund>, 'create' | 'save'> &
      Partial<Pick<Repository<Refund>, 'findOne'>>,
  ): Promise<Refund> {
    const payment = data.paymentId ? await findPayment(data.paymentId) : null
    if (!payment || !data.brandId || payment.brandId !== data.brandId) {
      throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
    }

    if (
      payment.amount !== undefined &&
      payment.amount !== null &&
      Number(data.amount) > Number(payment.amount)
    ) {
      throw new RequestException(
        {
          code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT',
          message: 'Refund amount cannot exceed the payment amount',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    if (payment.status === PaymentStatus.REFUNDED) {
      throw new RequestException(
        {
          code: 'PAYMENT_ALREADY_REFUNDED',
          message: 'Payment has already been refunded',
        },
        HttpStatus.CONFLICT,
      )
    }

    const existingPending =
      typeof refundRepo.findOne === 'function'
        ? await refundRepo.findOne({
            where: { paymentId: data.paymentId, status: RefundStatus.PENDING },
          })
        : null
    if (existingPending) {
      throw new RequestException(
        {
          code: 'REFUND_ALREADY_PENDING',
          message: 'A pending refund already exists for this payment',
        },
        HttpStatus.CONFLICT,
      )
    }

    const refund = refundRepo.create({
      brandId: data.brandId,
      paymentId: data.paymentId,
      amount: data.amount,
      currency: data.currency,
      reason: data.reason,
      provider: data.provider,
      requestedBy: data.requestedBy,
      description: data.description,
      metadata: data.metadata,
      status: RefundStatus.PENDING,
    })
    return refundRepo.save(refund)
  }

  /**
   * Aprobar un reembolso pendiente
   */
  async approve(id: string, approvedBy: string) {
    try {
      const refund = await this.refundRepository.findOne({ where: { id } })
      if (!refund) {
        throw new RequestException(
          { code: 'REFUND_NOT_FOUND', message: 'Reembolso no encontrado' },
          HttpStatus.NOT_FOUND,
        )
      }

      if (refund.status !== RefundStatus.PENDING) {
        throw new RequestException(
          { code: 'REFUND_NOT_PENDING', message: 'Solo se pueden aprobar reembolsos pendientes' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      refund.status = RefundStatus.PROCESSING
      refund.approvedBy = approvedBy
      const saved = await this.refundRepository.save(refund)

      this.logger.log(`Reembolso aprobado: ${id} por ${approvedBy}`)
      return { data: saved }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al aprobar reembolso ${id}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Listar reembolsos de una marca
   */
  async findByBrand(
    brandId: string,
    filters: { page?: number; limit?: number; status?: string } = {},
  ) {
    try {
      const { page = 1, limit = 20, status } = filters
      const skip = (page - 1) * limit

      const where: any = { brandId }
      if (status) where.status = status

      const [refunds, total] = await this.refundReadRepository.findAndCount({
        where,
        order: { createdAt: 'DESC' },
        skip,
        take: limit,
      })

      return {
        data: refunds,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      }
    } catch (error) {
      this.logger.error(`Error al listar reembolsos de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Obtener reembolso por ID
   */
  async findById(id: string) {
    try {
      const refund = await this.refundReadRepository.findOne({ where: { id } })
      if (!refund) {
        throw new RequestException(
          { code: 'REFUND_NOT_FOUND', message: 'Reembolso no encontrado' },
          HttpStatus.NOT_FOUND,
        )
      }
      return { data: refund }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al obtener reembolso ${id}: ${error.message}`)
      return { error: error.message }
    }
  }
}
