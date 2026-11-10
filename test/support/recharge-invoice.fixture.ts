import { randomUUID } from 'crypto'
import { DataSource } from 'typeorm'

import { AuditService } from '../../src/audit/audit.service'
import { AuditLog } from '../../src/audit/entities/auditLog.entity'
import { BillingProfile } from '../../src/billing-profile/entities/billingProfile.entity'
import { DianService } from '../../src/dian/dian.service'
import { Invoice } from '../../src/invoice/entities/invoice.entity'
import { InvoiceItem } from '../../src/invoice/entities/invoiceItem.entity'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../../src/payment/entities/payment.entity'
import { monthlyRechargeInvoiceNumber } from '../../src/invoice/recharge-invoice'
import { AutomaticRechargeInvoiceService } from '../../src/recharge/automatic-recharge-invoice.service'
import { DropiRechargeSignal } from '../../src/recharge/dropi-recharge-signal'
import { Wallet } from '../../src/wallet/entities/wallet.entity'
import { TokenOrigin } from '../../src/wallet/token-origin'
import { TokenWalletService } from '../../src/wallet/token-wallet.service'
import { apmDouble, ApmDouble, dianDouble, DianDouble } from './dropi-recharge.fixture'

/** 10 tokens at TRM 4,000 plus 19 % VAT, the shape `DropiRechargeService.create` stores. */
const TEN_TOKENS = { amount: 47600, subtotal: 40000, taxAmount: 7600 }

/** Instants in Bogota (UTC-5) around the close of October 2026. */
export const BOGOTA = {
  oct15: new Date('2026-10-15T17:00:00Z'),
  oct31LastSecond: new Date('2026-11-01T04:59:59Z'),
  nov1FirstSecond: new Date('2026-11-01T05:00:01Z'),
  nov2: new Date('2026-11-02T15:00:00Z'),
}

/** The 1st at 00:00 in Bogota that closes October, and the one that closes November. */
export const OCTOBER_CUTOFF = new Date('2026-11-01T05:00:00Z')
export const NOVEMBER_CUTOFF = new Date('2026-12-01T05:00:00Z')

/** `legacy` leaves `automatic` out, like a recharge made before LOC-206. */
export type RechargeKind = 'automatic' | 'manual' | 'legacy'

/** A completed recharge from Dropi, as LOC-175 leaves it, paid at `paidAt`. */
export function completedRecharge(
  dataSource: DataSource,
  brandId: string,
  paidAt: Date,
  kind: RechargeKind = 'automatic',
  amounts = TEN_TOKENS,
) {
  const repo = dataSource.getRepository(Payment)
  const terms = { tokens: 10, tokenPriceUsd: 1, bonusTokens: 0 }
  return repo.save(
    repo.create({
      brandId,
      userId: 'member-loc206',
      idempotencyKey: `dropi-recharge:${randomUUID()}`,
      provider: PaymentProvider.DROPI_WALLET,
      purpose: PaymentPurpose.TOKEN_RECHARGE,
      providerPaymentId: `dropi-op-${randomUUID()}`,
      amount: amounts.amount,
      currency: 'COP',
      exchangeRate: 4000,
      exchangeRateDate: '2026-10-15',
      status: PaymentStatus.COMPLETED,
      paidAt,
      metadata: {
        country: 'CO',
        taxRate: 0.19,
        taxName: 'IVA',
        subtotal: amounts.subtotal,
        taxAmount: amounts.taxAmount,
        dropiRecharge: kind === 'legacy' ? terms : { ...terms, automatic: kind === 'automatic' },
      },
    }),
  )
}

export function invoicesOf(dataSource: DataSource, brandId: string) {
  return dataSource
    .getRepository(Invoice)
    .find({ where: { brandId }, relations: ['items'], order: { createdAt: 'ASC' } })
}

export function itemsReferencing(dataSource: DataSource, paymentId: string) {
  return dataSource.getRepository(InvoiceItem).findBy({ referenceId: paymentId })
}

export async function invoiceIdOf(dataSource: DataSource, paymentId: string) {
  return (await dataSource.getRepository(Payment).findOneByOrFail({ id: paymentId })).invoiceId
}

/**
 * Makes the brand's close of `period` fail in the database: an invoice with no period already holds
 * the monthly number, so the insert hits the unique number and no period invoice explains it.
 */
export function takeMonthlyInvoiceNumber(dataSource: DataSource, brandId: string, period: string) {
  const repo = dataSource.getRepository(Invoice)
  return repo.save(
    repo.create({
      brandId,
      invoiceNumber: monthlyRechargeInvoiceNumber(brandId, period),
      subtotal: 0,
      total: 0,
      currency: 'COP',
    }),
  )
}

/** A refund made as a gift of tokens, the way the admin gift route credits it: no payment. */
export async function refundGift(dataSource: DataSource, brandId: string) {
  const tokens = new TokenWalletService(dataSource.getRepository(Wallet), dataSource)
  const wallet = await tokens.getOrCreate(brandId, brandId)
  const reason = 'Refund of a recharge'
  const movement = await tokens.creditTokens(
    wallet.id,
    10,
    TokenOrigin.GIFT,
    { brandId, category: 'gift', description: reason, metadata: { reason } },
    `admin:${randomUUID()}`,
  )
  return movement.transaction
}

/** The real close on `dataSource`, one per service instance; only the DIAN and New Relic are doubles. */
export function closeOn(
  dataSource: DataSource,
  dian: DianDouble = dianDouble(),
  apm: ApmDouble = apmDouble(),
) {
  const audit = new AuditService(
    dataSource.getRepository(AuditLog),
    dataSource.getRepository(AuditLog),
  )
  return new AutomaticRechargeInvoiceService(
    dataSource,
    dataSource.getRepository(BillingProfile),
    audit,
    dian as unknown as DianService,
    new DropiRechargeSignal(apm),
  )
}
