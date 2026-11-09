import { EntityManager } from 'typeorm'

import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { Payment } from '../payment/entities/payment.entity'
import { toCents } from '../wallet/token-spend'
import { Invoice, InvoiceStatus } from './entities/invoice.entity'
import { InvoiceItem } from './entities/invoiceItem.entity'

const SERVICE_DESCRIPTION = 'Recarga de tokens ROAX pagada con saldo Dropi'

const prefix = () => process.env.INVOICE_PREFIX || 'CK'
const compact = (id: string) => id.replace(/-/g, '').toUpperCase()

/** Number of the invoice of one manual recharge; unique because the payment is. */
export const manualRechargeInvoiceNumber = (paymentId: string) =>
  `${prefix()}-R-${compact(paymentId)}`

/** Number of a brand's monthly recharge invoice; unique because `(brand, period)` is. */
export const monthlyRechargeInvoiceNumber = (brandId: string, period: string) =>
  `${prefix()}-${period.replace('-', '')}-${compact(brandId)}`

/** One invoice line per recharge, with the subtotal, VAT and total fixed when it was created. */
export function rechargeInvoiceItem(payment: Payment): Partial<InvoiceItem> {
  const tokens = Number(payment.metadata.dropiRecharge.tokens)
  const subtotal = Number(payment.metadata.subtotal)
  return {
    description: `${SERVICE_DESCRIPTION}: ${tokens} tokens`,
    quantity: 1,
    unitPrice: subtotal,
    subtotal,
    taxRate: Number(payment.metadata.taxRate),
    taxAmount: Number(payment.metadata.taxAmount),
    total: Number(payment.amount),
    productType: 'token_recharge',
    referenceType: 'payment',
    referenceId: payment.id,
  }
}

const sum = (items: Partial<InvoiceItem>[], field: 'subtotal' | 'taxAmount' | 'total') =>
  items.reduce((cents, item) => cents + toCents(Number(item[field])), 0) / 100

export interface RechargeInvoiceDraft {
  /** Chosen by the caller when the recharges already point at it. */
  id: string
  brandId: string
  invoiceNumber: string
  /** Set on the invoice of a single (manual) recharge. */
  paymentId?: string
  /** Set on a monthly invoice. */
  period?: string
  billingProfile: BillingProfile | null
  /** The recharges it invoices; all COP, so the totals are their sums. */
  recharges: Payment[]
}

/**
 * Writes a paid COP invoice and one item per recharge with `manager`, so it commits or rolls back
 * with the caller's transaction. Throws on any write error, unique violations included.
 */
export async function insertRechargeInvoice(
  manager: EntityManager,
  draft: RechargeInvoiceDraft,
): Promise<Invoice> {
  const items = draft.recharges.map(rechargeInvoiceItem)
  const profile = draft.billingProfile
  const now = new Date()
  const invoice = await manager.save(
    Invoice,
    manager.create(Invoice, {
      id: draft.id,
      brandId: draft.brandId,
      paymentId: draft.paymentId ?? null,
      period: draft.period ?? null,
      billingProfileId: profile?.id ?? null,
      invoiceNumber: draft.invoiceNumber,
      subtotal: sum(items, 'subtotal'),
      taxTotal: sum(items, 'taxAmount'),
      total: sum(items, 'total'),
      currency: 'COP',
      status: InvoiceStatus.PAID,
      issuedAt: now,
      paidAt: now,
      metadata: {
        serviceDescription: SERVICE_DESCRIPTION,
        taxRate: Number(draft.recharges[0]?.metadata?.taxRate ?? 0),
        taxName: draft.recharges[0]?.metadata?.taxName ?? 'N/A',
        buyer: {
          brandId: draft.brandId,
          ...(profile
            ? {
                billingProfileId: profile.id,
                legalName: profile.legalName,
                taxId: profile.taxId,
                taxIdType: profile.taxIdType,
                email: profile.email,
                country: profile.country,
              }
            : {}),
        },
      },
    } as Partial<Invoice>),
  )
  await manager.save(
    InvoiceItem,
    items.map((item) => manager.create(InvoiceItem, { ...item, invoiceId: invoice.id })),
  )
  return invoice
}
