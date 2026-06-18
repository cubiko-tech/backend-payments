import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { BillingProfile } from './entities/billingProfile.entity'
import { CountryBillingConfig } from './entities/countryBillingConfig.entity'
import { BrandLegalDocument } from './entities/brandLegalDocument.entity'
import { BillingProfileController } from './billing-profile.controller'
import { BillingProfileService } from './billing-profile.service'
import { CountryBillingConfigService } from './country-billing-config.service'
import { LegalDocumentService } from './legal-document.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([BillingProfile, BrandLegalDocument], 'DBWrite'),
    TypeOrmModule.forFeature([BillingProfile, CountryBillingConfig, BrandLegalDocument], 'DBRead'),
  ],
  controllers: [BillingProfileController],
  providers: [BillingProfileService, CountryBillingConfigService, LegalDocumentService],
  exports: [BillingProfileService, CountryBillingConfigService, LegalDocumentService],
})
export class BillingProfileModule {}
