import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Invoice } from './entities/invoice.entity'
import { InvoiceItem } from './entities/invoiceItem.entity'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { InvoiceController } from './invoice.controller'
import { InvoiceService } from './invoice.service'
import { InvoicePdfService } from './invoice-pdf.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([Invoice, InvoiceItem], 'DBWrite'),
    TypeOrmModule.forFeature([Invoice, InvoiceItem, BillingProfile], 'DBRead'),
  ],
  controllers: [InvoiceController],
  providers: [InvoiceService, InvoicePdfService],
  exports: [InvoiceService, InvoicePdfService],
})
export class InvoiceModule {}
