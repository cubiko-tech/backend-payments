import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { TrmWeeklyService } from './trm-weekly.service'

/**
 * Stores the week's TRM on Mondays at 00:30 in Bogota, and on startup when the week has none yet.
 * Every instance runs it; `recordThisWeek` keeps one row per week.
 */
@Injectable()
export class TrmWeeklyRateTask implements OnApplicationBootstrap {
  private readonly log = new Logger(TrmWeeklyRateTask.name)

  constructor(private readonly weekly: TrmWeeklyService) {}

  onApplicationBootstrap(): void {
    // Not awaited: a slow or failing source must not hold the service's startup.
    void this.tick()
  }

  @Cron('30 0 * * 1', { timeZone: 'America/Bogota' })
  async tick(): Promise<void> {
    try {
      const week = await this.weekly.recordThisWeek()
      this.log.log(
        `Week of ${week.weekStart} uses TRM ${week.rate} (in force from ${week.rateDate})`,
      )
    } catch (error) {
      this.log.error(`Weekly TRM not stored: ${(error as Error).message}`)
    }
  }
}
