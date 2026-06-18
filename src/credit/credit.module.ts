import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { CreditScore } from './entities/creditScore.entity'
import { ScoreScaleConfig } from './entities/scoreScaleConfig.entity'
import { CreditController } from './credit.controller'
import { CreditService } from './credit.service'
import { ScaleConfigService } from './scale-config.service'
import { CreditInputsClient } from './client/credit-inputs.client'

/**
 * Fase 2 del scoring de crédito: motor + snapshots en backend-payments.
 * El buró (providers, RBAC, consentimiento) es Fase 5; los runs masivos, Fase 3.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CreditScore, ScoreScaleConfig], 'DBWrite'),
    TypeOrmModule.forFeature([CreditScore, ScoreScaleConfig], 'DBRead'),
  ],
  controllers: [CreditController],
  providers: [CreditService, ScaleConfigService, CreditInputsClient],
  exports: [CreditService, ScaleConfigService],
})
export class CreditModule {}
