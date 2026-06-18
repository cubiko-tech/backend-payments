import { Injectable } from '@nestjs/common'
import { Cron } from '@nestjs/schedule'
import { MetricsService } from './metrics.service'
import { logger } from '../shared/logger/logger'

/**
 * Cron para generar snapshots diarios de métricas.
 * Se ejecuta a las 4am todos los días.
 */
@Injectable()
export class MetricsCron {
  constructor(private readonly metricsService: MetricsService) {}

  @Cron('0 4 * * *')
  async generateDailySnapshot() {
    try {
      await this.metricsService.generateDailySnapshot()
      logger.log('info', '[CRON] generateDailySnapshot: completado')
    } catch (error) {
      logger.log('error', `[CRON] generateDailySnapshot: error: ${error.message}`)
    }
  }
}
