import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'

import { AutomaticRechargeInvoiceService } from '../recharge/automatic-recharge-invoice.service'
import { BILLING_TIME_ZONE } from '../recharge/billing-period'

/**
 * On the 1st of each month at 00:00 in Bogota, invoices the previous month's automatic recharges
 * from Dropi, one invoice per brand. Every instance runs it; the close itself keeps it to one.
 */
@Injectable()
export class AutomaticRechargeInvoiceCloseTask {
  constructor(private readonly close: AutomaticRechargeInvoiceService) {}

  // Not `closeMonth` itself: the cron library calls the handler with its own first argument.
  @Cron('0 0 1 * *', { timeZone: BILLING_TIME_ZONE })
  async tick(): Promise<void> {
    await this.close.closeMonth(new Date())
  }
}
