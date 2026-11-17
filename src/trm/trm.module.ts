import { Module } from '@nestjs/common'
import { DEFAULT_TRM_SOURCE_URL, TRM_SOURCE_URL, TrmService } from './trm.service'

@Module({
  providers: [
    TrmService,
    {
      provide: TRM_SOURCE_URL,
      useFactory: () => process.env.TRM_SOURCE_URL || DEFAULT_TRM_SOURCE_URL,
    },
  ],
  exports: [TrmService],
})
export class TrmModule {}
