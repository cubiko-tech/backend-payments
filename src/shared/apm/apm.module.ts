import { Module } from '@nestjs/common'

import { APM_AGENT, loadApmAgent } from './apm-agent'

@Module({
  providers: [{ provide: APM_AGENT, useFactory: () => loadApmAgent() }],
  exports: [APM_AGENT],
})
export class ApmModule {}
