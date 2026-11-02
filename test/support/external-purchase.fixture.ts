import { DataSource } from 'typeorm'

import { AuditLog } from '../../src/audit/entities/auditLog.entity'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../../src/payment/entities/payment.entity'
import { Subscription } from '../../src/subscription/entities/subscription.entity'
import { backdate, PLAN_PRICE } from './wallet-race.fixture'

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
