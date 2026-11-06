import { Module } from '@nestjs/common'
import { TrmService } from './trm.service'

@Module({
  providers: [TrmService],
  exports: [TrmService],
})
export class TrmModule {}
