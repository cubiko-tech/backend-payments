import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BullModule } from '@nestjs/bullmq'

import { CreditScore } from './entities/creditScore.entity'
import { ScoreScaleConfig } from './entities/scoreScaleConfig.entity'
import { ScoreRun } from './entities/scoreRun.entity'
import { CreditController } from './credit.controller'
import { CreditService } from './credit.service'
import { ScaleConfigService } from './scale-config.service'
import { CreditInputsClient } from './client/credit-inputs.client'
import { CreditRunService, CREDIT_RUN_QUEUE } from './credit-run.service'
import { CreditRunProcessor } from './credit-run.processor'

/**
 * Scoring de crédito en backend-payments. Fase 2: motor + snapshots. Fase 3: runs
 * masivos durables (BullMQ, cola `credit-run`). El buró (providers, RBAC,
 * consentimiento) es Fase 5.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CreditScore, ScoreScaleConfig, ScoreRun], 'DBWrite'),
    TypeOrmModule.forFeature([CreditScore, ScoreScaleConfig, ScoreRun], 'DBRead'),
    BullModule.registerQueue({ name: CREDIT_RUN_QUEUE }),
  ],
  controllers: [CreditController],
  providers: [
    CreditService,
    ScaleConfigService,
    CreditInputsClient,
    CreditRunService,
    CreditRunProcessor,
  ],
  exports: [CreditService, ScaleConfigService, CreditRunService],
})
export class CreditModule {}
