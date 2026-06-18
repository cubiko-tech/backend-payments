import { Processor, WorkerHost } from '@nestjs/bullmq'
import { Logger } from '@nestjs/common'
import { Job } from 'bullmq'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { WebhookEvent, WebhookStatus } from './entities/webhookEvent.entity'

/**
 * Processor de BullMQ para reintentar webhooks fallidos.
 *
 * Backoff exponencial: 1min, 5min, 30min.
 * Después de 3 reintentos fallidos → dead letter (status = 'dead').
 *
 * BullMQ no usa @Process('named'); el processor extiende WorkerHost e
 * implementa process(job), despachando por job.name.
 */
@Processor('webhook-retry')
export class WebhookRetryProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookRetryProcessor.name)

  constructor(
    @InjectRepository(WebhookEvent, 'DBWrite')
    private readonly webhookEventRepo: Repository<WebhookEvent>,
  ) {
    super()
  }

  async process(job: Job<{ eventId: string }>): Promise<void> {
    const { eventId } = job.data
    this.logger.log(`Reintentando webhook ${eventId} (intento ${job.attemptsMade + 1})`)

    const event = await this.webhookEventRepo.findOne({ where: { id: eventId } })
    if (!event) {
      this.logger.warn(`Webhook ${eventId} no encontrado, descartando`)
      return
    }

    if (event.status === WebhookStatus.PROCESSED) {
      this.logger.log(`Webhook ${eventId} ya fue procesado, descartando reintento`)
      return
    }

    // Incrementar contador de reintentos
    event.retryCount = (event.retryCount || 0) + 1
    event.status = WebhookStatus.PROCESSING
    await this.webhookEventRepo.save(event)

    // El reprocesamiento real lo hace el webhook service
    // Aquí solo marcamos para que el cron lo recoja
    // o podemos re-emitir el dispatch directamente
    throw new Error(`Webhook ${eventId} pendiente de reprocesamiento`)
  }
}
