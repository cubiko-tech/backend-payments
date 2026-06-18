import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BullModule } from '@nestjs/bullmq'
import { JwtModule } from '@nestjs/jwt'

import { CreditScore } from './entities/creditScore.entity'
import { ScoreScaleConfig } from './entities/scoreScaleConfig.entity'
import { ScoreRun } from './entities/scoreRun.entity'
import { CreditProfile } from './entities/creditProfile.entity'
import { BureauCheck } from './entities/bureauCheck.entity'
import { CreditController } from './credit.controller'
import { CreditService } from './credit.service'
import { ScaleConfigService } from './scale-config.service'
import { CreditInputsClient } from './client/credit-inputs.client'
import { CreditRunService, CREDIT_RUN_QUEUE } from './credit-run.service'
import { CreditRunProcessor } from './credit-run.processor'
import { BureauService } from './bureau/bureau.service'
import { CreditPermissionGuard } from './guard/credit-permission.guard'
import { AuditModule } from '../audit/audit.module'
import { ClientModule } from '../client/client.module'

/**
 * Scoring de crédito en backend-payments. Fase 2: motor + snapshots. Fase 3: runs
 * masivos durables (BullMQ, cola `credit-run`). El buró (providers, RBAC,
 * consentimiento) es Fase 5.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [CreditScore, ScoreScaleConfig, ScoreRun, CreditProfile, BureauCheck],
      'DBWrite',
    ),
    TypeOrmModule.forFeature(
      [CreditScore, ScoreScaleConfig, ScoreRun, CreditProfile, BureauCheck],
      'DBRead',
    ),
    BullModule.registerQueue({ name: CREDIT_RUN_QUEUE }),
    JwtModule.register({ secret: process.env.JWT_SECRET }),
    AuditModule,
    ClientModule,
  ],
  controllers: [CreditController],
  providers: [
    CreditService,
    ScaleConfigService,
    CreditInputsClient,
    CreditRunService,
    CreditRunProcessor,
    BureauService,
    CreditPermissionGuard,
  ],
  exports: [CreditService, ScaleConfigService, CreditRunService, BureauService],
})
export class CreditModule {}
