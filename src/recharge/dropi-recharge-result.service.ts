import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, EntityManager, Repository } from 'typeorm'

import { AuditService } from '../audit/audit.service'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payment/entities/payment.entity'
import { ROAX_ADS_CLIENT } from '../shared/auth/require-permission.decorator'
import { TokenOrigin } from '../wallet/token-origin'
import { toCents } from '../wallet/token-spend'
import { TokenWalletService, fail } from '../wallet/token-wallet.service'
import { DropiChargeResult, decideRechargeResult } from './dropi-recharge-result'
import { DropiRechargeSignal } from './dropi-recharge-signal'
import { DropiRechargeTerms, DropiRechargeView, toView } from './dropi-recharge.service'
import { ReportDropiRechargeResultDto } from './dto/report-dropi-recharge-result.dto'

export const dropiTokensKey = (paymentId: string) => `payment:${paymentId}:tokens:dropi`

/** Thrown inside the credit transaction when another call closed the recharge first. */
class ClosedMeanwhile extends Error {}

/** Thrown inside the credit transaction when the Dropi operation already closed another recharge. */
class OperationUsedElsewhere extends Error {}

const DROPI_OPERATION_INDEX = 'UQ_payments_dropi_operation'

/**
 * Closes a recharge from Dropi with the result ROAX Ads reports: `charged` credits its fixed tokens
 * to the `dropi` origin, `failed` closes it with none. The credit, the close and their audit commit
 * together. Rejects: an unknown or other brand's recharge (404), another amount (422), a report
 * that does not match a closed recharge (409), a Dropi operation that already charged another
 * recharge (409, stays pending) and a closed token wallet (422, stays pending).
 */
@Injectable()
export class DropiRechargeResultService {
  private readonly logger = new Logger(DropiRechargeResultService.name)

  constructor(
    @InjectRepository(Payment, 'DBWrite')
    private readonly payments: Repository<Payment>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
    private readonly tokenWallets: TokenWalletService,
    private readonly auditService: AuditService,
    private readonly signal: DropiRechargeSignal,
  ) {}

  async report(id: string, body: ReportDropiRechargeResultDto): Promise<DropiRechargeView> {
    const payment = await this.findRecharge(id, body)
    const decision = decideRechargeResult(storedOf(payment), body)
    if (decision === 'replay') return toView(payment)
    if (decision === 'conflict') throw alreadyClosed()
    return body.status === DropiChargeResult.CHARGED
      ? this.credit(payment, body)
      : this.closeFailed(payment, body)
  }

  private async findRecharge(id: string, body: ReportDropiRechargeResultDto): Promise<Payment> {
    const payment = await this.payments.findOne({ where: { id } })
    const isRecharge =
      payment?.provider === PaymentProvider.DROPI_WALLET &&
      payment.purpose === PaymentPurpose.TOKEN_RECHARGE
    if (!payment || !isRecharge || payment.brandId !== body.brandId) {
      throw fail('RECHARGE_NOT_FOUND', 'Recharge not found for this brand', HttpStatus.NOT_FOUND)
    }
    if (toCents(Number(payment.amount)) !== toCents(body.amount)) {
      throw fail(
        'RECHARGE_AMOUNT_MISMATCH',
        'The amount is not the one of the recharge',
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    return payment
  }

  private async credit(payment: Payment, body: ReportDropiRechargeResultDto) {
    const terms: DropiRechargeTerms = payment.metadata.dropiRecharge
    const tokens = Number(terms.tokens)
    const dropiOperationId = body.dropiOperationId
    try {
      const movement = await this.tokenWallets.creditTokens(
        payment.walletId,
        tokens,
        TokenOrigin.DROPI,
        {
          brandId: payment.brandId,
          category: 'dropi_recharge',
          description: `Recharge from Dropi ${payment.id}`,
          referenceType: 'payment',
          referenceId: payment.id,
          metadata: { dropiOperationId },
        },
        dropiTokensKey(payment.id),
        async (manager, transaction) => {
          const changes = {
            status: PaymentStatus.COMPLETED,
            paidAt: new Date(),
            providerPaymentId: dropiOperationId,
          }
          const closed = await closePending(manager, payment.id, changes).catch((error) => {
            // Not the 23505 the wallet reads as a replayed key: this one answers on its own.
            throw violates(error, DROPI_OPERATION_INDEX) ? new OperationUsedElsewhere() : error
          })
          if (!closed) throw new ClosedMeanwhile()
          await this.auditService.record(manager, {
            userId: ROAX_ADS_CLIENT,
            action: 'dropi_recharge_charged',
            entityType: 'payment',
            entityId: payment.id,
            changes: {
              brandId: payment.brandId,
              tokens,
              dropiOperationId,
              transactionId: transaction.id,
            },
            description: `Recharge from Dropi charged: ${tokens} tokens`,
          })
        },
      )
      // A replay did not run the close above: what the recharge holds now decides the answer.
      return movement.replayed ? this.decideAgain(payment.id, body) : this.closedView(payment.id)
    } catch (error) {
      if (error instanceof ClosedMeanwhile) return this.decideAgain(payment.id, body)
      if (error instanceof OperationUsedElsewhere) {
        this.logger.warn(
          `Dropi operation ${dropiOperationId} already closed another recharge; ${payment.id} stays pending`,
        )
        throw fail(
          'DROPI_OPERATION_ALREADY_USED',
          'This Dropi operation already closed another recharge',
          HttpStatus.CONFLICT,
        )
      }
      throw error
    }
  }

  private async closeFailed(payment: Payment, body: ReportDropiRechargeResultDto) {
    const dropiOperationId = body.dropiOperationId ?? null
    const closed = await this.dataSource.transaction(async (manager) => {
      const changes = {
        status: PaymentStatus.FAILED,
        failureReason: 'dropi_charge_failed',
        // Not `providerPaymentId`: the external reconcile sweep queries every pending one that has it.
        metadata: () => `COALESCE("metadata", '{}'::jsonb) || CAST(:result AS jsonb)`,
      }
      const result = JSON.stringify({ dropiOperationId })
      if (!(await closePending(manager, payment.id, changes, { result }))) return false
      await this.auditService.record(manager, {
        userId: ROAX_ADS_CLIENT,
        action: 'dropi_recharge_failed',
        entityType: 'payment',
        entityId: payment.id,
        changes: { brandId: payment.brandId, dropiOperationId },
        description: 'Recharge from Dropi failed: no tokens',
      })
      return true
    })
    return closed ? this.closedView(payment.id) : this.decideAgain(payment.id, body)
  }

  /** Answers a report that another call overtook, from the recharge as that call left it. */
  private async decideAgain(id: string, body: ReportDropiRechargeResultDto) {
    const payment = await this.payments.findOneOrFail({ where: { id } })
    const decision = decideRechargeResult(storedOf(payment), body)
    if (decision === 'replay') return toView(payment)
    if (decision === 'conflict') throw alreadyClosed()
    throw new Error(`Recharge ${id} is still pending after another call closed it`)
  }

  /** The view of a recharge this call just closed, which is the only close that signals. */
  private async closedView(id: string) {
    const payment = await this.payments.findOneOrFail({ where: { id } })
    this.signal.changed(payment)
    return toView(payment)
  }
}

/** `UPDATE … WHERE status = 'pending'`: true when this call is the one that closed the recharge. */
async function closePending(
  manager: EntityManager,
  id: string,
  changes: Record<string, unknown>,
  parameters: Record<string, unknown> = {},
): Promise<boolean> {
  const result = await manager
    .createQueryBuilder()
    .update(Payment)
    .set(changes)
    .where('id = :id AND status = :pending', { id, pending: PaymentStatus.PENDING })
    .setParameters(parameters)
    .execute()
  return result.affected === 1
}

/** A unique violation (23505) of the index `constraint`, as the pg driver reports it. */
function violates(error: unknown, constraint: string): boolean {
  const driver = (error as { driverError?: { code?: string; constraint?: string } })?.driverError
  return driver?.code === '23505' && driver.constraint === constraint
}

function storedOf(payment: Payment) {
  const dropiOperationId =
    payment.status === PaymentStatus.COMPLETED
      ? payment.providerPaymentId
      : payment.metadata?.dropiOperationId
  return { status: payment.status, dropiOperationId }
}

function alreadyClosed() {
  return fail(
    'RECHARGE_ALREADY_CLOSED',
    'The recharge is already closed with another result',
    HttpStatus.CONFLICT,
  )
}
