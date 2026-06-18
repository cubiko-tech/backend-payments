import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Invoice } from '../invoice/entities/invoice.entity'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { DianController } from './dian.controller'
import { DianService } from './dian.service'
import { AuditModule } from '../audit/audit.module'
import { BillingProfileModule } from '../billing-profile/billing-profile.module'

@Module({
  imports: [
    TypeOrmModule.forFeature([Invoice], 'DBWrite'),
    TypeOrmModule.forFeature([Invoice, BillingProfile], 'DBRead'),
    AuditModule,
    BillingProfileModule,
  ],
  controllers: [DianController],
  providers: [DianService],
  exports: [DianService],
})
export class DianModule {}
