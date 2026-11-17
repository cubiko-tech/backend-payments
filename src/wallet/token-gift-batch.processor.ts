import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { TOKEN_GIFT_BATCH_QUEUE, TokenGiftBatchService } from './token-gift-batch.service'

export interface GiftBatchJobData {
  batchId: string
}

@Processor(TOKEN_GIFT_BATCH_QUEUE)
export class TokenGiftBatchProcessor extends WorkerHost {
  private readonly logger = new Logger(TokenGiftBatchProcessor.name)

  constructor(private readonly giftBatchService: TokenGiftBatchService) {
    super()
  }

  async process(job: Job<GiftBatchJobData>): Promise<void> {
    this.logger.log(
      `Processing token gift batch ${job.data.batchId} (attempt ${job.attemptsMade + 1})`,
    )
    await this.giftBatchService.executeBatch(job.data.batchId)
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<GiftBatchJobData>): Promise<void> {
    const attempts = job.opts?.attempts ?? 1
    if (job.attemptsMade >= attempts) {
      this.logger.error(`Token gift batch ${job.data.batchId} failed after ${attempts} attempts`)
      await this.giftBatchService.markFailed(job.data.batchId)
    }
  }
}
