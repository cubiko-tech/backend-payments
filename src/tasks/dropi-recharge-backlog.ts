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
import { DropiRechargeSignal } from '../recharge/dropi-recharge-signal'

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
    return this.run()
  }

  async run(): Promise<void> {
    // The age is measured by the database clock, the one that set createdAt, not the app's.
    const row = await this.payments
      .createQueryBuilder('payment')
      .select('COUNT(*)', 'pending')
      .addSelect('FLOOR(EXTRACT(EPOCH FROM now() - MIN(payment.createdAt)))', 'oldest')
      .where('payment.provider = :provider', { provider: PaymentProvider.DROPI_WALLET })
      .andWhere('payment.purpose = :purpose', { purpose: PaymentPurpose.TOKEN_RECHARGE })
      .andWhere('payment.status = :status', { status: PaymentStatus.PENDING })
      .getRawOne<{ pending: string; oldest: string | null }>()
    this.signal.backlog(Number(row?.pending ?? 0), Number(row?.oldest ?? 0))
  }
}
