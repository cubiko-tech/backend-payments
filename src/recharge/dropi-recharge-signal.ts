import { Inject, Injectable, Logger } from '@nestjs/common'

import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { APM_AGENT, ApmAgent, ApmAttributes } from '../shared/apm/apm-agent'
import type { DropiRechargeTerms } from './dropi-recharge.service'

export const DROPI_RECHARGE_EVENT = 'DropiRecharge'
export const DROPI_RECHARGE_BACKLOG_EVENT = 'DropiRechargeBacklog'

const STATUS_OF: Partial<Record<PaymentStatus, string>> = {
  [PaymentStatus.PENDING]: 'pending',
  [PaymentStatus.COMPLETED]: 'charged',
  [PaymentStatus.FAILED]: 'failed',
}

export const secondsSince = (from: Date, now: Date) =>
  Math.floor((now.getTime() - new Date(from).getTime()) / 1000)

/**
 * What a recharge from Dropi tells New Relic: one `DropiRecharge` event per state change and one
 * `DropiRechargeBacklog` per sweep. Never the user, their token or the ROAX Ads credential. A
 * failing agent is logged and never reaches the caller: the recharge already committed.
 */
@Injectable()
export class DropiRechargeSignal {
  private readonly log = new Logger(DropiRechargeSignal.name)

  constructor(@Inject(APM_AGENT) private readonly agent: ApmAgent) {}

  changed(payment: Payment, now = new Date()): void {
    this.record(DROPI_RECHARGE_EVENT, () => {
      const terms: DropiRechargeTerms = payment.metadata.dropiRecharge
      return {
        rechargeId: payment.id,
        status: STATUS_OF[payment.status] ?? payment.status,
        tokens: Number(terms.tokens),
        amountCop: Number(payment.amount),
        ageSeconds: secondsSince(payment.createdAt, now),
      }
    })
  }

  backlog(pending: number, oldestPendingSeconds: number): void {
    this.record(DROPI_RECHARGE_BACKLOG_EVENT, () => ({ pending, oldestPendingSeconds }))
  }

  private record(eventType: string, attributes: () => ApmAttributes): void {
    try {
      this.agent.recordCustomEvent(eventType, attributes())
    } catch (error) {
      this.log.warn(`${eventType} not recorded: ${(error as Error).message}`)
    }
  }
}
