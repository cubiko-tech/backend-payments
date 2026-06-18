import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectQueue } from '@nestjs/bullmq'
import { Repository, In } from 'typeorm'
import { Queue } from 'bullmq'
import { WebhookEvent, WebhookStatus } from './entities/webhookEvent.entity'
import { Payment } from '../payment/entities/payment.entity'

const MAX_WEBHOOK_RETRIES = 3

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name)

  // Inyectado después de que CheckoutModule se registre
  private checkoutService: any = null

  constructor(
    @InjectRepository(WebhookEvent, 'DBWrite')
    private readonly webhookEventRepository: Repository<WebhookEvent>,
    @InjectRepository(WebhookEvent, 'DBRead')
    private readonly webhookEventReadRepository: Repository<WebhookEvent>,
    @InjectRepository(Payment, 'DBRead')
    private readonly paymentReadRepo: Repository<Payment>,
    @InjectQueue('webhook-retry')
    private readonly retryQueue: Queue,
  ) {}

  /**
   * Inyección tardía del CheckoutService para evitar dependencia circular.
   */
  setCheckoutService(checkoutService: any) {
    this.checkoutService = checkoutService
  }

  /**
   * Recibir y registrar un evento de webhook.
   */
  async receive(
    provider: string,
    eventType: string,
    providerEventId: string,
    payload: any,
  ) {
    try {
      // Idempotencia
      const existing = await this.webhookEventReadRepository.findOne({
        where: { providerEventId },
      })

      if (existing) {
        this.logger.warn(`Evento duplicado ignorado: ${providerEventId} (${provider})`)
        return { data: existing, duplicate: true }
      }

      const event = this.webhookEventRepository.create({
        provider,
        eventType,
        providerEventId,
        payload,
        status: WebhookStatus.RECEIVED,
      })
      const saved = await this.webhookEventRepository.save(event)

      this.logger.log(`Webhook recibido: ${provider}/${eventType} (${providerEventId})`)

      // Procesar async
      this.processEvent(saved).catch((error) => {
        this.logger.error(`Error procesando webhook ${saved.id}: ${error.message}`)
      })

      return { data: saved }
    } catch (error) {
      this.logger.error(`Error al recibir webhook de ${provider}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Procesar evento de webhook — despacha al flujo correcto según provider + eventType.
   */
  private async processEvent(event: WebhookEvent) {
    try {
      event.status = WebhookStatus.PROCESSING
      await this.webhookEventRepository.save(event)

      await this.dispatchEvent(event)

      event.status = WebhookStatus.PROCESSED
      event.processedAt = new Date()
      await this.webhookEventRepository.save(event)
    } catch (error) {
      event.error = error.message
      event.retryCount = (event.retryCount || 0) + 1

      if (event.retryCount >= MAX_WEBHOOK_RETRIES) {
        // Máximo de reintentos alcanzado → dead letter
        event.status = WebhookStatus.FAILED
        this.logger.error(`Webhook ${event.id} fallido definitivamente después de ${MAX_WEBHOOK_RETRIES} intentos`)
      } else {
        // Encolar para reintento con backoff exponencial
        event.status = WebhookStatus.FAILED
        const delays = [60000, 300000, 1800000] // 1min, 5min, 30min
        const delay = delays[event.retryCount - 1] || 1800000

        await this.retryQueue.add('retry', { eventId: event.id }, {
          delay,
          attempts: 1,
          removeOnComplete: true,
        })
        this.logger.warn(`Webhook ${event.id} fallido, reintento #${event.retryCount} en ${delay / 1000}s`)
      }

      await this.webhookEventRepository.save(event)
      throw error
    }
  }

  /**
   * Despachar evento al handler correcto.
   */
  private async dispatchEvent(event: WebhookEvent) {
    const { provider, eventType, payload } = event

    // =============================================
    // STRIPE
    // =============================================
    if (provider === 'stripe') {
      // Pago completado (checkout session o payment intent)
      if (
        eventType === 'checkout.session.completed' ||
        eventType === 'payment_intent.succeeded'
      ) {
        const paymentId = payload.data?.object?.metadata?.paymentId
          || await this.findPaymentByProviderIds(payload.data?.object?.id)

        if (paymentId) {
          await this.completePayment(paymentId, payload.data?.object)
        }
        return
      }

      // Reembolso
      if (eventType === 'charge.refunded') {
        this.logger.log(`Stripe refund recibido: ${payload.data?.object?.id}`)
        // Los reembolsos se manejan desde RefundService, este es solo confirmación
        return
      }

      // Suscripción renovada
      if (eventType === 'invoice.paid') {
        const subscriptionId = payload.data?.object?.subscription
        if (subscriptionId) {
          this.logger.log(`Stripe subscription renewed: ${subscriptionId}`)
          // Para suscripciones manejadas por Stripe directamente
        }
        return
      }

      // Pago de suscripción fallido
      if (eventType === 'invoice.payment_failed') {
        this.logger.warn(`Stripe subscription payment failed: ${payload.data?.object?.subscription}`)
        return
      }
    }

    // =============================================
    // MERCADOPAGO
    // =============================================
    if (provider === 'mercadopago') {
      if (eventType === 'payment' && payload.action === 'payment.created') {
        // Consultar estado del pago en MP
        const mpPaymentId = payload.data?.id
        if (mpPaymentId) {
          // Buscar nuestro payment por el external_reference o metadata
          const paymentId = await this.findPaymentByProviderIds(String(mpPaymentId))
          if (paymentId) {
            await this.completePayment(paymentId, { mpPaymentId })
          }
        }
        return
      }
    }

    // =============================================
    // DROPI
    // =============================================
    if (provider === 'dropi') {
      if (eventType === 'charge.completed' || eventType === 'payment.completed') {
        const chargeId = payload.chargeId || payload.data?.chargeId
        if (chargeId) {
          const paymentId = await this.findPaymentByProviderIds(chargeId)
          if (paymentId) {
            await this.completePayment(paymentId, payload)
          }
        }
        return
      }

      if (eventType === 'charge.failed') {
        this.logger.warn(`Dropi charge failed: ${payload.chargeId}`)
        return
      }
    }

    this.logger.warn(`Evento no manejado: ${provider}/${eventType}`)
  }

  /**
   * Completar un pago — delega al CheckoutService.
   */
  private async completePayment(paymentId: string, providerData: any) {
    if (this.checkoutService) {
      await this.checkoutService.completeExternalPayment(paymentId, providerData)
    } else {
      this.logger.warn(`CheckoutService no disponible, pago ${paymentId} pendiente de completar`)
    }
  }

  /**
   * Listar todos los webhooks con filtros y stats (admin).
   */
  async getAllWebhooks(filters: { status?: string; provider?: string; limit?: number }) {
    const where: any = {}
    if (filters.status) where.status = filters.status
    if (filters.provider) where.provider = filters.provider

    const events = await this.webhookEventReadRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: filters.limit || 100,
      select: ['id', 'provider', 'eventType', 'providerEventId', 'status', 'error', 'retryCount', 'processedAt', 'createdAt'],
    })

    // Stats globales
    const all = await this.webhookEventReadRepository.find({ select: ['status', 'provider'] })
    const byStatus: Record<string, number> = {}
    const byProvider: Record<string, number> = {}
    for (const e of all) {
      byStatus[e.status] = (byStatus[e.status] || 0) + 1
      byProvider[e.provider] = (byProvider[e.provider] || 0) + 1
    }

    const deadLetters = events.filter((e) => e.status === 'failed' && e.retryCount >= 3).length

    return { data: events, meta: { total: all.length, byStatus, byProvider, deadLetters } }
  }

  /**
   * Listar webhooks fallidos (admin dashboard).
   */
  async getFailedWebhooks(limit = 50) {
    const events = await this.webhookEventReadRepository.find({
      where: { status: In([WebhookStatus.FAILED]) },
      order: { createdAt: 'DESC' },
      take: limit,
    })
    return { data: events }
  }

  /**
   * Reintentar un webhook fallido manualmente.
   */
  async retryWebhook(eventId: string) {
    const event = await this.webhookEventRepository.findOne({ where: { id: eventId } })
    if (!event) {
      return { error: 'Webhook no encontrado' }
    }

    event.retryCount = 0
    event.status = WebhookStatus.RECEIVED
    event.error = null
    await this.webhookEventRepository.save(event)

    // Reprocesar
    this.processEvent(event).catch((error) => {
      this.logger.error(`Error reprocesando webhook ${event.id}: ${error.message}`)
    })

    return { data: { message: 'Reintento encolado', eventId } }
  }

  /**
   * Buscar payment interno por providerPaymentId.
   */
  private async findPaymentByProviderIds(providerId: string): Promise<string | null> {
    if (!providerId) return null

    const payment = await this.paymentReadRepo.findOne({
      where: { providerPaymentId: providerId },
    })

    return payment?.id || null
  }
}
