import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { MetricsSnapshot } from './entities/metricsSnapshot.entity'
import { MetricsController } from './metrics.controller'
import { MetricsService } from './metrics.service'
import { MetricsCron } from './metrics.cron'

@Module({
  imports: [
    TypeOrmModule.forFeature([MetricsSnapshot], 'DBWrite'),
    TypeOrmModule.forFeature([MetricsSnapshot], 'DBRead'),
  ],
  controllers: [MetricsController],
  providers: [MetricsService, MetricsCron],
  exports: [MetricsService],
})
export class MetricsModule {}
