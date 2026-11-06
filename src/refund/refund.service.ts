import { Injectable, Logger, HttpStatus } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository } from 'typeorm'
import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { Refund, RefundStatus } from './entities/refund.entity'
import { RequestException } from '../shared/exception/request.exception'
import { isUniqueConstraintViolation } from '../checkout/checkout-idempotency'
import { Wallet } from '../wallet/entities/wallet.entity'
import {
  holdsPackageTokens,
  isTokenPackage,
  packageTokensOf,
  reclaimPackageTokens,
  tokensSpent,
} from '../wallet/token-package-reclaim'

// `decimal` columns arrive as strings; integer cents keep the sum exact.
const toCents = (amount: unknown) => Math.round(Number(amount) * 100)

const refundInFlight = () =>
  new RequestException(
    {
      code: 'REFUND_ALREADY_PENDING',
      message: 'Another refund for this payment is pending or processing',
    },
    HttpStatus.CONFLICT,
  )

const refundNotPending = () =>
  new RequestException(
    { code: 'REFUND_NOT_PENDING', message: 'Solo se pueden aprobar reembolsos pendientes' },
    HttpStatus.UNPROCESSABLE_ENTITY,
  )

/** Where `approvePending` reads and writes: the approving transaction, or plain repositories. */
interface ApproveOps {
  findRefund: (id: string) => Promise<Refund | null>
  findPayment: (id: string) => Promise<Payment | null>
  reclaim: (payment: Payment) => Promise<unknown>
  save: (refund: Refund) => Promise<Refund>
}

/** A package is refunded whole, and only while the brand still holds all of its tokens. */
async function assertPackageRefundable(
  payment: Payment,
  amount: unknown,
  findWallet: (id: string) => Promise<Wallet | null>,
) {
  if (toCents(amount) !== toCents(payment.amount)) {
    throw new RequestException(
      {
        code: 'TOKEN_PACKAGE_PARTIAL_REFUND',
        message: 'A token package can only be refunded in full',
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
  const tokens = packageTokensOf(payment)
  const wallet = tokens ? await findWallet(payment.walletId) : null
  if (!holdsPackageTokens(wallet, payment, tokens)) throw tokensSpent()
}

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
                (id) => manager.findOne(Wallet, { where: { id } }),
              ),
            )
          : await this.createPendingRefund(
              data,
              (id) => this.paymentReadRepository.findOne({ where: { id } }),
              this.refundRepository,
              async () => null,
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
    refundRepo: Pick<Repository<Refund>, 'create' | 'save' | 'find'>,
    findWallet: (id: string) => Promise<Wallet | null>,
  ): Promise<Refund> {
    const payment = data.paymentId ? await findPayment(data.paymentId) : null
    if (!payment || !data.brandId || payment.brandId !== data.brandId) {
      throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
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
    if (payment.status !== PaymentStatus.COMPLETED) {
      throw new RequestException(
        {
          code: 'PAYMENT_NOT_COMPLETED',
          message: 'Only a completed payment can be refunded',
        },
        HttpStatus.CONFLICT,
      )
    }
    if (String(data.currency ?? '').toUpperCase() !== String(payment.currency).toUpperCase()) {
      throw new RequestException(
        {
          code: 'REFUND_CURRENCY_MISMATCH',
          message: 'Refund currency must match the payment currency',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    const activeRefunds = await refundRepo.find({
      where: {
        paymentId: payment.id,
        status: In([RefundStatus.PENDING, RefundStatus.PROCESSING, RefundStatus.COMPLETED]),
      },
    })
    const inFlight = (status: RefundStatus) => activeRefunds.some((r) => r.status === status)
    // An unapproved request wins over the cap so a repeated POST keeps answering 409.
    if (inFlight(RefundStatus.PENDING)) throw refundInFlight()

    const approvedCents = activeRefunds.reduce((sum, r) => sum + toCents(r.amount), 0)
    if (approvedCents + toCents(data.amount) > toCents(payment.amount)) {
      throw new RequestException(
        {
          code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT',
          message: 'Refunded plus requested amount cannot exceed the payment amount',
        },
        HttpStatus.BAD_REQUEST,
      )
    }
    if (inFlight(RefundStatus.PROCESSING)) throw refundInFlight()
    if (isTokenPackage(payment)) await assertPackageRefundable(payment, data.amount, findWallet)

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
   * Approves a pending refund. For a token package it takes back the package tokens in the same
   * transaction (422 `TOKEN_PACKAGE_TOKENS_SPENT` when they are gone). The refund row is locked, so
   * a concurrent approval waits and answers 422 `REFUND_NOT_PENDING`; any other failure rolls back
   * and is rethrown.
   */
  async approve(id: string, approvedBy: string) {
    const manager = this.refundRepository.manager
    try {
      const saved =
        typeof manager?.transaction === 'function'
          ? await manager.transaction((m) =>
              this.approvePending(id, approvedBy, {
                findRefund: (rid) =>
                  m.findOne(Refund, { where: { id: rid }, lock: { mode: 'pessimistic_write' } }),
                findPayment: (pid) => m.findOne(Payment, { where: { id: pid } }),
                reclaim: (payment) => reclaimPackageTokens(m, payment, id),
                save: (refund) => m.save(Refund, refund),
              }),
            )
          : await this.approvePending(id, approvedBy, {
              findRefund: (rid) => this.refundRepository.findOne({ where: { id: rid } }),
              findPayment: (pid) => this.paymentReadRepository.findOne({ where: { id: pid } }),
              reclaim: async () => {
                throw tokensSpent()
              },
              save: (refund) => this.refundRepository.save(refund),
            })
      this.logger.log(`Reembolso aprobado: ${id} por ${approvedBy}`)
      return { data: saved }
    } catch (error) {
      if (error instanceof RequestException) throw error
      // The refund lock makes a second debit of the same refund unreachable; its key is the backstop.
      if (isUniqueConstraintViolation(error)) throw refundNotPending()
      this.logger.error(`Error al aprobar reembolso ${id}: ${error.message}`)
      throw error
    }
  }

  private async approvePending(id: string, approvedBy: string, ops: ApproveOps): Promise<Refund> {
    const refund = await ops.findRefund(id)
    if (!refund) {
      throw new RequestException(
        { code: 'REFUND_NOT_FOUND', message: 'Reembolso no encontrado' },
        HttpStatus.NOT_FOUND,
      )
    }
    if (refund.status !== RefundStatus.PENDING) throw refundNotPending()

    const payment = await ops.findPayment(refund.paymentId)
    if (payment && isTokenPackage(payment)) await ops.reclaim(payment)

    refund.status = RefundStatus.PROCESSING
    refund.approvedBy = approvedBy
    return ops.save(refund)
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
