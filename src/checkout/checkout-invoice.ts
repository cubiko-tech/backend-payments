import { Repository } from 'typeorm'

import { Payment } from '../payment/entities/payment.entity'
import { InvoiceStatus } from '../invoice/entities/invoice.entity'
import { InvoiceService } from '../invoice/invoice.service'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { DianService } from '../dian/dian.service'
import { logger as winstonLogger } from '../shared/logger/logger'

export interface CheckoutInvoiceDeps {
  billingProfileRepo: Repository<BillingProfile>
  invoiceService: Pick<InvoiceService, 'create'>
}

export interface CheckoutDianDeps {
  dianService: Pick<DianService, 'sendInvoice' | 'isConfigured'>
  logger: { warn: (message: string) => void }
}

/** Issues the paid invoice of a checkout, one line per purpose, and returns it; throws if it was not created. */
export async function generateInvoice(
  deps: CheckoutInvoiceDeps,
  payment: Payment,
  req: any,
  subtotal: number,
  taxAmount: number,
  currency: string,
  tax: any,
  extendedUntil?: Date,
): Promise<any> {
  const billingProfile = await deps.billingProfileRepo.findOne({
    where: { brandId: payment.brandId },
  })

  const suffix = payment?.id
    ? `-${String(payment.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`
    : ''
  const invoiceNumber = `${process.env.INVOICE_PREFIX || 'CK'}-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}${suffix}`

  const invoiceTotal = Math.round((subtotal + taxAmount) * 100) / 100
  const items = []

  if (req.purpose === 'plan_purchase') {
    const description = extendedUntil
      ? `Extensión del plan ${req.planSlug} hasta ${extendedUntil.toISOString()}`
      : `Plan ${req.planSlug} — Suscripción mensual Cubiko`
    items.push({
      description,
      quantity: 1,
      unitPrice: subtotal,
      subtotal,
      taxRate: tax.taxRate ?? 0,
      taxAmount,
      total: invoiceTotal,
      productType: 'plan',
      referenceType: 'subscription',
      referenceId: req.planSlug,
    })
  } else if (req.purpose === 'token_package') {
    items.push({
      description: tokenPackageInvoiceDescription(payment),
      quantity: 1,
      unitPrice: subtotal,
      subtotal,
      taxRate: tax.taxRate ?? 0,
      taxAmount,
      total: invoiceTotal,
      productType: 'token_package',
      referenceType: 'payment',
      referenceId: payment.id,
    })
  } else if (req.purpose === 'token_amount') {
    items.push({
      description: tokenAmountInvoiceDescription(payment),
      quantity: 1,
      unitPrice: subtotal,
      subtotal,
      taxRate: tax.taxRate ?? 0,
      taxAmount,
      total: invoiceTotal,
      productType: 'token_amount',
      referenceType: 'payment',
      referenceId: payment.id,
    })
  } else if (req.purpose === 'wallet_recharge') {
    items.push({
      description: 'Créditos de uso de la plataforma ROAX',
      quantity: 1,
      unitPrice: subtotal,
      subtotal,
      taxRate: tax.taxRate ?? 0,
      taxAmount,
      total: invoiceTotal,
      productType: 'recharge',
      referenceType: 'payment',
      referenceId: payment.id,
    })
  } else {
    items.push({
      description: 'Pago de servicio Cubiko',
      quantity: 1,
      unitPrice: subtotal,
      subtotal,
      taxRate: tax.taxRate ?? 0,
      taxAmount,
      total: invoiceTotal,
      productType: 'service',
      referenceType: 'payment',
      referenceId: payment.id,
    })
  }

  const requestBuyer = req?.buyer || payment.metadata?.buyer
  const buyerIdentification = {
    brandId: payment.brandId,
    userId: payment.userId,
    ...(billingProfile
      ? {
          billingProfileId: billingProfile.id,
          legalName: billingProfile.legalName,
          taxId: billingProfile.taxId,
          taxIdType: billingProfile.taxIdType,
          email: billingProfile.email,
          country: billingProfile.country,
        }
      : {}),
    ...(requestBuyer
      ? {
          firstName: requestBuyer.firstName,
          lastName: requestBuyer.lastName,
          name:
            [requestBuyer.firstName, requestBuyer.lastName].filter(Boolean).join(' ') ||
            billingProfile?.legalName ||
            undefined,
          email: requestBuyer.email || billingProfile?.email,
          phoneNumber: requestBuyer.phoneNumber || billingProfile?.phone,
        }
      : {}),
  }

  const result = await deps.invoiceService.create({
    brandId: payment.brandId,
    paymentId: payment.id,
    billingProfileId: billingProfile?.id || null,
    invoiceNumber,
    subtotal,
    taxTotal: taxAmount,
    total: invoiceTotal,
    currency,
    status: InvoiceStatus.PAID,
    issuedAt: new Date(),
    paidAt: new Date(),
    ...(req.purpose === 'wallet_recharge' ||
    req.purpose === 'token_package' ||
    req.purpose === 'token_amount'
      ? {
          metadata: {
            serviceDescription:
              req.purpose === 'token_package'
                ? tokenPackageInvoiceDescription(payment)
                : req.purpose === 'token_amount'
                  ? tokenAmountInvoiceDescription(payment)
                  : 'Créditos de uso de la plataforma ROAX',
            taxRate: tax.taxRate ?? 0,
            taxName: tax.taxName || 'N/A',
            buyer: buyerIdentification,
          },
        }
      : {}),
    items,
  })

  if (result && typeof result === 'object' && 'error' in result && (result as any).error) {
    throw new Error((result as any).error)
  }
  if (!result?.data) {
    throw new Error('Failed to create invoice')
  }

  return result.data
}

export function sendToDianAsync(deps: CheckoutDianDeps, invoiceId: string, currency: string) {
  if (!canSendToDian(deps, invoiceId, currency)) return

  // Fire and forget: the buyer's response does not wait for the DIAN.
  deps.dianService.sendInvoice(invoiceId).catch((error) => {
    winstonLogger.log('error', `Error enviando factura ${invoiceId} a DIAN: ${error.message}`)
  })
}

export function canSendToDian(
  deps: CheckoutDianDeps,
  invoiceId: string,
  currency: string,
): boolean {
  // DIAN/Siigo invoicing applies only to COP documents; `DianService` defaults a missing billing profile to CO.
  if (currency && currency.toUpperCase() !== 'COP') {
    deps.logger.warn(
      `Factura ${invoiceId} emitida en ${currency}: no se envía a la DIAN ` +
        '(facturación electrónica colombiana)',
    )
    return false
  }

  return deps.dianService.isConfigured()
}

/** The invoiced line of a token package: only the paid tokens, the bonus is not invoiced. */
function tokenPackageInvoiceDescription(payment: Payment): string {
  return `Paquete de ${Number(payment.metadata?.tokenPackage?.purchasedTokens)} tokens ROAX`
}

function tokenAmountInvoiceDescription(payment: Payment): string {
  return `Compra de ${Number(payment.metadata?.tokenAmount?.purchasedTokens)} tokens ROAX`
}
