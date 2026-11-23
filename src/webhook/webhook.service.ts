// R6: Keeps webhook reception, retry scheduling, provider dispatch, and admin inspection together.
import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectQueue } from '@nestjs/bullmq'
import { Repository, In } from 'typeorm'
import { Queue } from 'bullmq'
import { WebhookEvent, WebhookStatus } from './entities/webhookEvent.entity'
import { Payment, PaymentProvider } from '../payment/entities/payment.entity'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { classifyConfioWebhookEvent } from '../provider/confio/confio-webhook'
import { MAX_CONFIO_STRING_LENGTH } from '../provider/confio/confio-webhook-signature'
import {
  ConfioNoticeOutcome,
  ConfioSubscriptionWebhookService,
} from './confio-subscription-webhook.service'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { resolveMercadoPagoNotice } from './mercadopago-payment-notice'
import { ConfioWebhookPayload } from '../provider/confio/confio.types'
import { escapeLogValue } from '../shared/logger/log-value'
import { RequestException } from '../shared/exception/request.exception'
import { isUniqueViolation } from '../shared/db/unique-violation'

const MAX_WEBHOOK_RETRIES = 3
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name)

  // Set late by CheckoutModule to break a circular dependency; null until then.
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
    private readonly confioSubscriptions: ConfioSubscriptionWebhookService,
    private readonly mercadoPagoProvider: MercadoPagoProvider,
  ) {}

  setCheckoutService(checkoutService: any) {
    this.checkoutService = checkoutService
  }

  async receive(provider: string, eventType: string, providerEventId: string, payload: any) {
    try {
      // Pre-check against DBWrite; concurrent uniqueness is enforced by
      // `UQ_webhook_events_provider_event` on `(provider, providerEventId)` and the 23505 branch.
      const existing = await this.webhookEventRepository.findOne({
        where: { provider, providerEventId },
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

      let saved: WebhookEvent
      try {
        saved = await this.webhookEventRepository.save(event)
      } catch (error) {
        if (!isUniqueViolation(error)) throw error

        // Lost the race to another delivery of the same notice: a duplicate, not a failure.
        // Not dispatched; safe because completing a payment is idempotent downstream too.
        const winner = await this.webhookEventRepository.findOne({
          where: { provider, providerEventId },
        })
        this.logger.warn(
          `Evento duplicado ignorado (índice único): ${providerEventId} (${provider})`,
        )
        return { data: winner, duplicate: true }
      }

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
   * Keeps an event that is not dispatched, as `ignored`. Its key carries its own prefix and the event,
   * so it never takes the key of a dispatched event with the same `data` (the one-shot key does not
   * carry the event).
   */
  async recordIgnored(
    provider: string,
    eventType: string,
    providerEventId: string,
    payload: ConfioWebhookPayload,
  ) {
    const key = `ignored:${eventType}:${providerEventId}`
    try {
      const saved = await this.webhookEventRepository.save(
        this.webhookEventRepository.create({
          provider,
          eventType,
          providerEventId: key,
          payload,
          status: WebhookStatus.IGNORED,
          processedAt: new Date(),
        }),
      )
      return { data: saved }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error
      this.logger.warn(`Duplicate ignored event: ${escapeLogValue(key)} (${provider})`)
      return { duplicate: true }
    }
  }

  private async processEvent(event: WebhookEvent) {
    try {
      event.status = WebhookStatus.PROCESSING
      await this.webhookEventRepository.save(event)

      const outcome = await this.dispatchEvent(event)

      event.status =
        outcome === 'out_of_order' ? WebhookStatus.OUT_OF_ORDER : WebhookStatus.PROCESSED
      event.processedAt = new Date()
      await this.webhookEventRepository.save(event)
    } catch (error) {
      event.error = error.message
      event.retryCount = (event.retryCount || 0) + 1

      if (event.retryCount >= MAX_WEBHOOK_RETRIES) {
        // Dead letter: only a manual admin retry brings it back.
        event.status = WebhookStatus.FAILED
        this.logger.error(
          `Webhook ${event.id} fallido definitivamente después de ${MAX_WEBHOOK_RETRIES} intentos`,
        )
      } else {
        event.status = WebhookStatus.FAILED
        const delays = [60000, 300000, 1800000] // 1min, 5min, 30min
        const delay = delays[event.retryCount - 1] || 1800000

        await this.retryQueue.add(
          'retry',
          { eventId: event.id },
          {
            delay,
            attempts: 1,
            removeOnComplete: true,
          },
        )
        this.logger.warn(
          `Webhook ${event.id} fallido, reintento #${event.retryCount} en ${delay / 1000}s`,
        )
      }

      await this.webhookEventRepository.save(event)
      throw error
    }
  }

  private async dispatchEvent(event: WebhookEvent): Promise<ConfioNoticeOutcome | void> {
    const { provider, eventType, payload } = event

    if (provider === 'stripe') {
      if (eventType === 'checkout.session.completed' || eventType === 'payment_intent.succeeded') {
        const stripeObject = payload.data?.object
        if (eventType === 'checkout.session.completed' && stripeObject?.payment_status !== 'paid') {
          return
        }
        const paymentId = await this.findPaymentByProviderIds(
          stripeObject?.id,
          PaymentProvider.STRIPE,
        )

        if (paymentId) {
          await this.completePayment(paymentId, stripeObject, PaymentProvider.STRIPE)
        }
        return
      }

      if (eventType === 'charge.refunded') {
        this.logger.log(`Stripe refund recibido: ${payload.data?.object?.id}`)
        // Log only: RefundService owns refunds, this event is just the provider's confirmation.
        return
      }

      if (eventType === 'invoice.paid') {
        const subscriptionId = payload.data?.object?.subscription
        if (subscriptionId) {
          this.logger.log(`Stripe subscription renewed: ${subscriptionId}`)
        }
        return
      }

      if (eventType === 'invoice.payment_failed') {
        this.logger.warn(
          `Stripe subscription payment failed: ${payload.data?.object?.subscription}`,
        )
        return
      }
    }

    if (provider === 'mercadopago') {
      if (eventType === 'payment' && payload.action === 'payment.created') {
        const mpPaymentId = payload.data?.id
        if (mpPaymentId !== undefined && mpPaymentId !== null && String(mpPaymentId) !== '') {
          const resolved = await resolveMercadoPagoNotice(
            this.mercadoPagoProvider,
            this.paymentReadRepo,
            String(mpPaymentId),
          )
          if (resolved) {
            await this.completePayment(
              resolved.paymentId,
              resolved.providerData,
              PaymentProvider.MERCADOPAGO,
            )
          }
        }
        return
      }
    }

    if (provider === 'dropi') {
      if (eventType === 'charge.completed' || eventType === 'payment.completed') {
        const chargeId = payload.chargeId || payload.data?.chargeId
        if (chargeId) {
          const paymentId = await this.findPaymentByProviderIds(chargeId, PaymentProvider.DROPI)
          if (paymentId) {
            await this.completePayment(paymentId, payload, PaymentProvider.DROPI)
          }
        }
        return
      }

      if (eventType === 'charge.failed') {
        this.logger.warn(`Dropi charge failed: ${payload.chargeId}`)
        return
      }
    }

    if (provider === 'confio') {
      // Signed `subscription.*` events route by event name; one-shot link notices below route by
      // `data.status`, since they arrive with no `signature` and no known `event`.
      if (classifyConfioWebhookEvent(payload?.event) === 'firmado') {
        return this.confioSubscriptions.handle(event)
      }

      const data = payload?.data || {}
      const status: string = data.status || ''

      if (ConfioProvider.isCompleted(status)) {
        const paymentId =
          (await this.findPaymentByProviderIds(data.name, PaymentProvider.CONFIO)) ||
          (await this.findPaymentByCorrelationId(
            data.correlationId,
            PaymentProvider.CONFIO,
            data.name,
          ))
        if (paymentId) {
          await this.completePayment(paymentId, payload, PaymentProvider.CONFIO)
        } else {
          this.logger.warn(
            `Confio: pago no encontrado para name=${data.name} correlationId=${data.correlationId}`,
          )
        }
        return
      }

      if (status === 'FAILED' || status === 'EXPIRED' || status === 'CANCELED') {
        this.logger.warn(`Confio pago no exitoso: ${data.name} status=${status}`)
        return
      }

      this.logger.log(`Confio estado intermedio ignorado: ${data.name} status=${status}`)
      return
    }

    this.logger.warn(`Evento no manejado: ${provider}/${eventType}`)
  }

  private async completePayment(
    paymentId: string,
    providerData: any,
    expectedProvider: PaymentProvider,
  ) {
    if (this.checkoutService) {
      await this.checkoutService.completeExternalPayment(paymentId, providerData, expectedProvider)
    } else {
      this.logger.warn(`CheckoutService no disponible, pago ${paymentId} pendiente de completar`)
    }
  }

  async getAllWebhooks(filters: { status?: string; provider?: string; limit?: number }) {
    const where: any = {}
    if (filters.status) where.status = filters.status
    if (filters.provider) where.provider = filters.provider

    const events = await this.webhookEventReadRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: filters.limit || 100,
      select: [
        'id',
        'provider',
        'eventType',
        'providerEventId',
        'status',
        'error',
        'retryCount',
        'processedAt',
        'createdAt',
      ],
    })

    // Stats cover every event, not only the filtered page.
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

  async getFailedWebhooks(limit = 50) {
    const events = await this.webhookEventReadRepository.find({
      where: { status: In([WebhookStatus.FAILED]) },
      order: { createdAt: 'DESC' },
      take: limit,
    })
    return { data: events }
  }

  async retryWebhook(eventId: string) {
    const event = await this.webhookEventRepository.findOne({ where: { id: eventId } })
    if (!event) {
      return { error: 'Webhook no encontrado' }
    }
    // An ignored event was never meant to be dispatched, and an out-of-order one is older than what applied.
    if (event.status === WebhookStatus.IGNORED || event.status === WebhookStatus.OUT_OF_ORDER) {
      throw new RequestException(
        { code: 'WEBHOOK_NOT_RETRYABLE', message: `Webhook ${event.status}: no se reintenta` },
        HttpStatus.CONFLICT,
      )
    }

    event.retryCount = 0
    event.status = WebhookStatus.RECEIVED
    event.error = null
    await this.webhookEventRepository.save(event)

    this.processEvent(event).catch((error) => {
      this.logger.error(`Error reprocesando webhook ${event.id}: ${error.message}`)
    })

    return { data: { message: 'Reintento encolado', eventId } }
  }

  /**
   * Look up internal payment by providerPaymentId and expected provider.
   */
  private async findPaymentByProviderIds(
    providerId: unknown,
    provider: PaymentProvider,
  ): Promise<string | null> {
    if (
      typeof providerId !== 'string' ||
      providerId.length === 0 ||
      providerId.length > MAX_CONFIO_STRING_LENGTH
    ) {
      return null
    }

    const payment = await this.paymentReadRepo.findOne({
      where: { providerPaymentId: providerId, provider },
    })

    return payment && payment.provider === provider && payment.providerPaymentId === providerId
      ? payment.id
      : null
  }

  /**
   * Look up internal payment by UUID correlationId and expected provider.
   */
  private async findPaymentByCorrelationId(
    correlationId: unknown,
    provider: PaymentProvider,
    providerPaymentId?: unknown,
  ): Promise<string | null> {
    if (typeof correlationId !== 'string' || !UUID_RE.test(correlationId)) return null
    if (
      providerPaymentId !== undefined &&
      providerPaymentId !== null &&
      (typeof providerPaymentId !== 'string' || providerPaymentId.length > MAX_CONFIO_STRING_LENGTH)
    ) {
      return null
    }

    const payment = await this.paymentReadRepo.findOne({
      where: { id: correlationId, provider },
    })

    if (!payment || payment.provider !== provider) return null
    if (
      payment.providerPaymentId &&
      providerPaymentId &&
      payment.providerPaymentId !== providerPaymentId
    ) {
      return null
    }

    return payment.id
  }
}
