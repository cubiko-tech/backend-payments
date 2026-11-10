import { Logger } from '@nestjs/common'

import { DianService } from '../dian/dian.service'

/**
 * Sends a committed recharge invoice to the DIAN in the background, as the checkout does: the
 * caller does not wait, and a failure is logged and leaves the invoice without CUFE. Recharge
 * invoices are always COP, so only whether the DIAN is configured decides.
 */
export function sendRechargeInvoiceToDian(dian: DianService, invoiceId: string, log: Logger) {
  if (!dian.isConfigured()) return
  dian.sendInvoice(invoiceId).catch((error) => {
    log.error(
      `Failed to send recharge invoice ${invoiceId} to the DIAN: ${error?.message ?? error}`,
    )
  })
}
