import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { TrmWeeklyRate } from './entities/trm-weekly-rate.entity'
import { TrmController } from './trm.controller'
import { TrmWeeklyRateTask } from './trm-weekly-rate.task'
import { TrmWeeklyService } from './trm-weekly.service'
import { TrmModule } from './trm.module'

/** The week's TRM: stored on Mondays, and served to ROAX Ads when the day's cannot be read. */
@Module({
  imports: [TrmModule, TypeOrmModule.forFeature([TrmWeeklyRate], 'DBWrite')],
  controllers: [TrmController],
  providers: [TrmWeeklyService, TrmWeeklyRateTask],
})
export class TrmWeeklyModule {}
