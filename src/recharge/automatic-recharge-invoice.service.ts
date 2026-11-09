import { Injectable, Logger } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { randomUUID } from 'crypto'
import { DataSource, EntityManager, In, Repository } from 'typeorm'

import { AuditService } from '../audit/audit.service'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { isUniqueConstraintViolation } from '../checkout/checkout-idempotency'
import { rollbackQuietly } from '../checkout/wallet-payment-close'
import { DianService } from '../dian/dian.service'
import { Invoice } from '../invoice/entities/invoice.entity'
import { insertRechargeInvoice, monthlyRechargeInvoiceNumber } from '../invoice/recharge-invoice'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payment/entities/payment.entity'
import { closingPeriod } from './billing-period'
import { sendRechargeInvoiceToDian } from './send-recharge-invoice'

/**
 * An automatic recharge from Dropi still to invoice in a close with cutoff `$4`: completed, not
 * invoiced and paid before the cutoff, with no lower bound, so one confirmed late is not lost.
 */
const PENDING_AUTOMATIC = `
  provider = $1 AND purpose = $2 AND status = $3 AND "invoiceId" IS NULL AND "paidAt" < $4
  AND metadata -> 'dropiRecharge' ->> 'automatic' = 'true'`

const pendingParams = (cutoff: Date) => [
  PaymentProvider.DROPI_WALLET,
  PaymentPurpose.TOKEN_RECHARGE,
  PaymentStatus.COMPLETED,
  cutoff,
]

export interface BrandClose {
  brandId: string
  invoice?: Invoice
  error?: string
}

/**
 * The monthly close of automatic recharges from Dropi: one paid invoice per brand and period with
 * all of them. Safe to run again and from several instances: a `brand:period` advisory lock, the
 * unique `(brandId, period)` index and a claim on `invoiceId IS NULL` keep a recharge in one invoice.
 */
@Injectable()
export class AutomaticRechargeInvoiceService {
  private readonly logger = new Logger(AutomaticRechargeInvoiceService.name)

  constructor(
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
    @InjectRepository(BillingProfile, 'DBRead')
    private readonly billingProfiles: Repository<BillingProfile>,
    private readonly auditService: AuditService,
    private readonly dian: DianService,
  ) {}

  /** Closes the month before `now`'s, brand by brand; a brand that fails is logged, not retried. */
  async closeMonth(now: Date): Promise<BrandClose[]> {
    const { period, cutoff } = closingPeriod(now)
    const brands: { brandId: string }[] = await this.dataSource.query(
      `SELECT DISTINCT "brandId" FROM payments WHERE ${PENDING_AUTOMATIC}`,
      pendingParams(cutoff),
    )
    const closes: BrandClose[] = []
    for (const { brandId } of brands) {
      try {
        const invoice = await this.closeBrand(brandId, period, cutoff)
        closes.push({ brandId, ...(invoice ? { invoice } : {}) })
      } catch (error) {
        this.logger.error(`Recharge invoice of ${brandId} for ${period} failed: ${error?.message}`)
        closes.push({ brandId, error: String(error?.message ?? error) })
      }
    }
    return closes
  }

  /**
   * Invoices the brand's pending automatic recharges for `period`, or returns null when nothing is
   * left to claim or the period already has its invoice; then the claim rolls back and the recharges
   * wait for the next close. The claim, the invoice and its audit commit together.
   */
  async closeBrand(brandId: string, period: string, cutoff: Date): Promise<Invoice | null> {
    const runner = this.dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    try {
      await runner.query(`SET LOCAL lock_timeout = '30s'`)
      await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `recharge-invoice:${brandId}:${period}`,
      ])
      const invoiceId = randomUUID()
      const [claimed]: [{ id: string }[]] = await runner.query(
        `UPDATE payments SET "invoiceId" = $5 WHERE "brandId" = $6 AND ${PENDING_AUTOMATIC}
         RETURNING id`,
        [...pendingParams(cutoff), invoiceId, brandId],
      )
      if (claimed.length === 0) {
        await runner.rollbackTransaction()
        return null
      }
      const recharges = await runner.manager.find(Payment, {
        where: { id: In(claimed.map((row) => row.id)) },
        order: { paidAt: 'ASC' },
      })
      const invoice = await insertRechargeInvoice(runner.manager, {
        id: invoiceId,
        brandId,
        invoiceNumber: monthlyRechargeInvoiceNumber(brandId, period),
        period,
        billingProfile: await this.billingProfiles.findOne({ where: { brandId } }),
        recharges,
      })
      await this.auditService.record(runner.manager, {
        userId: 'system',
        action: 'recharge_invoice_closed',
        entityType: 'invoice',
        entityId: invoice.id,
        changes: { brandId, period, paymentIds: recharges.map((p) => p.id), total: invoice.total },
        description: `Monthly invoice of ${recharges.length} automatic recharges for ${period}`,
      })
      await runner.commitTransaction()
      sendRechargeInvoiceToDian(this.dian, invoice.id, this.logger)
      return invoice
    } catch (error) {
      await rollbackQuietly(runner)
      // Either unique index (period or number) means another close may have won: what is stored decides.
      if (isUniqueConstraintViolation(error)) {
        if (await findPeriodInvoice(this.dataSource.manager, brandId, period)) return null
      }
      throw error
    } finally {
      await runner.release()
    }
  }
}

function findPeriodInvoice(manager: EntityManager, brandId: string, period: string) {
  return manager.findOne(Invoice, { where: { brandId, period } })
}
