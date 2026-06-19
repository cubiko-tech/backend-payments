import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'

import { CreditRunService, CREDIT_RUN_QUEUE } from './credit-run.service'

interface RunJobData {
  runId: string
}

/**
 * Worker durable del run masivo de scoring (Fase 3). Ejecuta el run delegando en
 * `CreditRunService.executeRun` (idempotente/reanudable). Si el job agota sus
 * reintentos, marca el run como `failed`. BullMQ extiende `WorkerHost` y despacha
 * por `process(job)` (mismo patrón que `webhook.processor.ts`).
 */
@Processor(CREDIT_RUN_QUEUE)
export class CreditRunProcessor extends WorkerHost {
  private readonly logger = new Logger(CreditRunProcessor.name)

  constructor(private readonly runService: CreditRunService) {
    super()
  }

  async process(job: Job<RunJobData>): Promise<void> {
    this.logger.log(`Ejecutando run ${job.data.runId} (intento ${job.attemptsMade + 1})`)
    await this.runService.executeRun(job.data.runId)
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<RunJobData>): Promise<void> {
    const attempts = job.opts?.attempts ?? 1
    if (job.attemptsMade >= attempts) {
      this.logger.error(`Run ${job.data.runId} falló tras ${attempts} intentos`)
      await this.runService.markFailed(job.data.runId)
    }
  }
}
