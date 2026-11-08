import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'

import { AuditModule } from '../audit/audit.module'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { Payment } from '../payment/entities/payment.entity'
import { ApmModule } from '../shared/apm/apm.module'
import { TaxModule } from '../tax/tax.module'
import { TrmModule } from '../trm/trm.module'
import { WalletModule } from '../wallet/wallet.module'
import { DropiRechargeResultController } from './dropi-recharge-result.controller'
import { DropiRechargeResultService } from './dropi-recharge-result.service'
import { DropiRechargeSignal } from './dropi-recharge-signal'
import { DropiRechargeController } from './dropi-recharge.controller'
import { DropiRechargeService } from './dropi-recharge.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment], 'DBWrite'),
    TypeOrmModule.forFeature([BillingProfile], 'DBRead'),
    ApmModule,
    AuditModule,
    TaxModule,
    TrmModule,
    WalletModule,
  ],
  controllers: [DropiRechargeController, DropiRechargeResultController],
  providers: [DropiRechargeService, DropiRechargeResultService, DropiRechargeSignal],
  exports: [DropiRechargeSignal],
})
export class RechargeModule {}
