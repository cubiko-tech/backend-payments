import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Payment } from '../payment/entities/payment.entity'
import { Refund } from './entities/refund.entity'
import { RefundController } from './refund.controller'
import { RefundService } from './refund.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([Refund], 'DBWrite'),
    TypeOrmModule.forFeature([Refund, Payment], 'DBRead'),
  ],
  controllers: [RefundController],
  providers: [RefundService],
  exports: [RefundService],
})
export class RefundModule {}
