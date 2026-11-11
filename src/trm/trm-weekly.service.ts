import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { TrmWeeklyRate } from './entities/trm-weekly-rate.entity'
import { bogotaDay, TrmService } from './trm.service'

/** Monday (`YYYY-MM-DD`) of the week `day` (`YYYY-MM-DD`) falls in. */
export function weekStartOf(day: string): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}

/** Keeps one TRM per week, the one in force on its Monday, as the reference when the day's fails. */
@Injectable()
export class TrmWeeklyService {
  constructor(
    @InjectRepository(TrmWeeklyRate, 'DBWrite')
    private readonly rates: Repository<TrmWeeklyRate>,
    private readonly trm: TrmService,
  ) {}

  /**
   * Stores the TRM in force on this week's Monday if the week has none yet, and returns the week's
   * row. Idempotent: a second call, or another instance, keeps the first row.
   */
  async recordThisWeek(now = Date.now()): Promise<TrmWeeklyRate> {
    const weekStart = weekStartOf(bogotaDay(now))
    const existing = await this.rates.findOneBy({ weekStart })
    if (existing) return existing
    const quote = await this.trm.rateOn(weekStart)
    await this.rates
      .createQueryBuilder()
      .insert()
      .into(TrmWeeklyRate)
      .values({ weekStart, rate: quote.rate, rateDate: quote.date })
      .orIgnore()
      .execute()
    return this.rates.findOneByOrFail({ weekStart })
  }

  /** The newest week's TRM, or null before any week is stored. */
  latest(): Promise<TrmWeeklyRate | null> {
    return this.rates.findOne({ where: {}, order: { weekStart: 'DESC' } })
  }
}
