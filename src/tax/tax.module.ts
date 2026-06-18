import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { TaxConfig } from './entities/taxConfig.entity'
import { TaxService } from './tax.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([TaxConfig], 'DBWrite'),
    TypeOrmModule.forFeature([TaxConfig], 'DBRead'),
  ],
  providers: [TaxService],
  exports: [TaxService],
})
export class TaxModule {}
