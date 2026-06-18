import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { createClient, RedisClientType } from 'redis'
import { logger } from '../shared/logger/logger'

/**
 * Servicio de Event Bus sobre Redis Streams.
 *
 * Publica eventos que otros servicios consumen asincrónicamente.
 * Cada evento se persiste en Redis hasta que todos los consumers lo procesen.
 *
 * Streams:
 * - events:payments → backend-roles, backend-realtime
 * - events:alerts → backend-realtime, backend-processes
 * - events:permissions → backend-realtime
 * - events:sync → backend-realtime, backend-ai
 */
@Injectable()
export class EventBusService implements OnModuleInit, OnModuleDestroy {
  private client: RedisClientType
  private connected = false

  async onModuleInit() {
    const host = process.env.REDIS_HOST || '192.160.1.5'
    const port = parseInt(process.env.REDIS_PORT || '6379')
    const password = process.env.REDIS_PASSWORD || undefined

    try {
      this.client = createClient({
        url: `redis://${host}:${port}`,
        ...(password && { password }),
      }) as RedisClientType
      this.client.on('error', (err) => {
        logger.log('error', `EventBus Redis error: ${err.message}`)
      })

      await this.client.connect()
      this.connected = true
      logger.log('info', `EventBus: conectado a Redis ${host}:${port}`)
    } catch (error) {
      logger.log('warn', `EventBus: no se pudo conectar a Redis (${error.message}), eventos se perderán`)
      this.connected = false
    }
  }

  async onModuleDestroy() {
    if (this.client && this.connected) {
      await this.client.quit()
    }
  }

  /**
   * Publicar evento en un stream.
   * Si Redis no está disponible, el evento se pierde silenciosamente (fire and forget).
   */
  async publish(stream: string, event: Record<string, string>): Promise<string | null> {
    if (!this.connected) return null

    try {
      const id = await this.client.xAdd(stream, '*', event)
      logger.log('info', `EventBus: publicado en ${stream} → ${event.type} (${id})`)
      return id
    } catch (error) {
      logger.log('error', `EventBus: error publicando en ${stream}: ${error.message}`)
      return null
    }
  }

  // =============================================================
  // Helpers tipados para eventos comunes
  // =============================================================

  async publishPaymentCompleted(data: {
    brandId: string
    paymentId: string
    amount: string
    currency: string
    purpose: string
    planSlug?: string
  }) {
    return this.publish('events:payments', {
      type: 'payment.completed',
      ...data,
      planSlug: data.planSlug || '',
      timestamp: new Date().toISOString(),
    })
  }

  async publishPaymentFailed(data: {
    brandId: string
    paymentId: string
    reason: string
  }) {
    return this.publish('events:payments', {
      type: 'payment.failed',
      ...data,
      timestamp: new Date().toISOString(),
    })
  }

  async publishSubscriptionExpired(data: {
    brandId: string
    subscriptionId: string
    planSlug: string
  }) {
    return this.publish('events:payments', {
      type: 'subscription.expired',
      ...data,
      timestamp: new Date().toISOString(),
    })
  }

  async publishSubscriptionRenewed(data: {
    brandId: string
    subscriptionId: string
    planSlug: string
  }) {
    return this.publish('events:payments', {
      type: 'subscription.renewed',
      ...data,
      timestamp: new Date().toISOString(),
    })
  }

  // =============================================================
  // Eventos de notificación
  // Consumidos por backend-processes para enviar email/whatsapp/push
  // =============================================================

  async publishNotification(data: {
    brandId: string
    userId?: string
    type: string           // payment_success, payment_failed, subscription_expiring, etc.
    channel?: string       // email, whatsapp, push, sms (backend-processes decide)
    subject?: string
    metadata?: Record<string, string>
  }) {
    return this.publish('events:notifications', {
      type: `notification.${data.type}`,
      brandId: data.brandId,
      userId: data.userId || '',
      channel: data.channel || 'email',
      subject: data.subject || '',
      ...data.metadata,
      timestamp: new Date().toISOString(),
    })
  }

  async notifyPaymentSuccess(brandId: string, paymentId: string, amount: string, currency: string) {
    return this.publishNotification({
      brandId,
      type: 'payment_success',
      subject: `Pago confirmado: ${amount} ${currency}`,
      metadata: { paymentId, amount, currency },
    })
  }

  async notifyPaymentFailed(brandId: string, paymentId: string, reason: string) {
    return this.publishNotification({
      brandId,
      type: 'payment_failed',
      subject: 'Tu pago no pudo ser procesado',
      metadata: { paymentId, reason },
    })
  }

  async notifySubscriptionExpiring(brandId: string, planSlug: string, daysLeft: string) {
    return this.publishNotification({
      brandId,
      type: 'subscription_expiring',
      subject: `Tu plan ${planSlug} expira en ${daysLeft} días`,
      metadata: { planSlug, daysLeft },
    })
  }

  async notifySubscriptionExpired(brandId: string, planSlug: string) {
    return this.publishNotification({
      brandId,
      type: 'subscription_expired',
      subject: `Tu plan ${planSlug} ha expirado`,
      metadata: { planSlug },
    })
  }

  async notifyInvoiceReady(brandId: string, invoiceId: string, invoiceNumber: string) {
    return this.publishNotification({
      brandId,
      type: 'invoice_ready',
      subject: `Factura ${invoiceNumber} disponible`,
      metadata: { invoiceId, invoiceNumber },
    })
  }

  /**
   * Verificar si Redis está disponible.
   */
  isConnected(): boolean {
    return this.connected
  }
}
