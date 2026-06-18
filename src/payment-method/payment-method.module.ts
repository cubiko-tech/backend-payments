import { Module } from '@nestjs/common'
import { TypeOrmModule } from '@nestjs/typeorm'
import { PaymentMethod } from './entities/paymentMethod.entity'
import { PaymentMethodController } from './payment-method.controller'
import { PaymentMethodService } from './payment-method.service'

@Module({
  imports: [
    TypeOrmModule.forFeature([PaymentMethod], 'DBWrite'),
    TypeOrmModule.forFeature([PaymentMethod], 'DBRead'),
  ],
  controllers: [PaymentMethodController],
  providers: [PaymentMethodService],
  exports: [PaymentMethodService],
})
export class PaymentMethodModule {}
