import { Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payment/entities/payment.entity'
import { DropiRechargeSignal, secondsSince } from '../recharge/dropi-recharge-signal'

/**
 * Every minute, how many recharges from Dropi are still pending and the age of the oldest one, in
 * seconds (0 with none). Nothing else closes them, so this is what shows one that got stuck. Each
 * instance records its own reading; the alert takes the maximum, so duplicates do not add up.
 */
@Injectable()
export class DropiRechargeBacklogTask {
  constructor(
    @InjectRepository(Payment, 'DBRead')
    private readonly payments: Repository<Payment>,
    private readonly signal: DropiRechargeSignal,
  ) {}

  // Not `run` itself: the cron library calls the handler with its own first argument.
  @Cron(CronExpression.EVERY_MINUTE)
  tick(): Promise<void> {
    return this.run(new Date())
  }

  async run(now: Date): Promise<void> {
    const row = await this.payments
      .createQueryBuilder('payment')
      .select('COUNT(*)', 'pending')
      .addSelect('MIN(payment.createdAt)', 'oldest')
      .where('payment.provider = :provider', { provider: PaymentProvider.DROPI_WALLET })
      .andWhere('payment.purpose = :purpose', { purpose: PaymentPurpose.TOKEN_RECHARGE })
      .andWhere('payment.status = :status', { status: PaymentStatus.PENDING })
      .getRawOne<{ pending: string; oldest: Date | null }>()
    const oldest = row?.oldest ? secondsSince(row.oldest, now) : 0
    this.signal.backlog(Number(row?.pending ?? 0), oldest)
  }
}
