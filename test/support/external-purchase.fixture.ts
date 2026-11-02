import { DataSource } from 'typeorm'

import { AuditLog } from '../../src/audit/entities/auditLog.entity'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../../src/payment/entities/payment.entity'
import { Subscription } from '../../src/subscription/entities/subscription.entity'
import { backdate, PLAN_PRICE, RaceInstance } from './wallet-race.fixture'

/** An external plan purchase waiting for its provider's confirmation. */
export async function seedExternalPurchase(
  dataSource: DataSource,
  brandId: string,
  planSlug: string,
  options: { age?: string; idempotencyKey?: string; checkoutUrl?: string } = {},
): Promise<Payment> {
  const repo = dataSource.getRepository(Payment)
  const payment = await repo.save(
    repo.create({
      brandId,
      userId: 'user-loc101',
      provider: PaymentProvider.STRIPE,
      purpose: PaymentPurpose.PLAN_PURCHASE,
      purposeId: planSlug,
      amount: PLAN_PRICE,
      currency: 'COP',
      status: PaymentStatus.PENDING,
      metadata: { country: 'CO', taxRate: 0.19, taxName: 'IVA' },
      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      ...(options.checkoutUrl ? { checkoutUrl: options.checkoutUrl } : {}),
    }),
  )
  if (options.age) {
    await backdate(dataSource, payment.id, options.age)
  }
  return repo.findOneByOrFail({ id: payment.id })
}

/** Moves the clock of the moment this purchase applied its plan. */
export function backdateEvent(dataSource: DataSource, paymentId: string, interval: string) {
  return dataSource.query(
    `UPDATE subscription_events SET "createdAt" = NOW() - INTERVAL '${interval}' WHERE "paymentId" = $1`,
    [paymentId],
  )
}

/** Runs the real sweep query over one brand's rows only. */
export function settleBrand(instance: RaceInstance, brandId: string) {
  const repo = (instance.tasks as any).paymentRepo
  const find = repo.find.bind(repo)
  // R17: The sweep reads all brands, and a spec in another worker must not close this one's rows.
  jest.spyOn(repo, 'find').mockImplementationOnce(async (options: unknown) => {
    const rows: Payment[] = await find(options)
    return rows.filter((row) => row.brandId === brandId)
  })
  return instance.tasks.settleLostExternalPayments()
}

export function subscriptionOf(dataSource: DataSource, brandId: string) {
  return dataSource.getRepository(Subscription).findOneBy({ brandId })
}

export function refundAudits(dataSource: DataSource, paymentId: string) {
  return dataSource
    .getRepository(AuditLog)
    .countBy({ entityId: paymentId, action: 'wallet_payment_refunded' })
}

export function paymentRow(dataSource: DataSource, paymentId: string) {
  return dataSource.getRepository(Payment).findOneByOrFail({ id: paymentId })
}
