import { Injectable } from '@nestjs/common'
import { timingSafeEqual } from 'crypto'
import {
  PaymentProvider,
  CreateCheckoutParams,
  CheckoutResult,
  PaymentStatusResult,
  RefundResult,
  CreateSubscriptionParams,
  SubscriptionResult,
  SaveMethodParams,
} from '../provider.interface'
import { logger } from '../../shared/logger/logger'

/**
 * ConfioPagos — pasarela de pagos colombiana (links de pago one-shot).
 *
 * Flujo: se crea un pago en `POST /stores/{storeId}/payments` que devuelve una
 * `url` (link de pago). El usuario paga y ConfioPagos confirma vía webhook
 * (validado por el mismo `CONFIO_ACCESS_TOKEN` en el header Authorization).
 *
 * No tiene checkout session como Stripe; es un link + confirmación asíncrona,
 * similar a Dropi pero con URL de pago. El cobro recurrente se resuelve
 * re-emitiendo un link cada período (ver TasksService.issueExternalCharge).
 *
 * Referencia de contrato: roax-ads-back/internal/payment/.../confiopagos_client.go
 */
@Injectable()
export class ConfioProvider implements PaymentProvider {
  readonly name = 'confio'

  private readonly baseUrl: string
  private readonly storeId: string | null
  private readonly accessToken: string | null

  constructor() {
    this.baseUrl =
      process.env.CONFIO_API_BASE_URL ||
      (process.env.GO_ENV === 'production' || process.env.NODE_ENV === 'production'
        ? 'https://api.confiopagos.com/v1'
        : 'https://api.dev.confiopagos.com/v1')

    const storeId = process.env.CONFIO_STORE_ID
    const token = process.env.CONFIO_ACCESS_TOKEN
    if (storeId && token && token !== 'CHANGEME') {
      this.storeId = storeId
      this.accessToken = token
      logger.log('info', `ConfioProvider: inicializado (${this.baseUrl})`)
    } else {
      this.storeId = null
      this.accessToken = null
      logger.log('warn', 'ConfioProvider: CONFIO_STORE_ID/CONFIO_ACCESS_TOKEN no configurados')
    }
  }

  private ensureConfigured() {
    if (!this.storeId || !this.accessToken) {
      throw new Error('ConfioPagos no configurado. Configure CONFIO_STORE_ID y CONFIO_ACCESS_TOKEN en .env')
    }
  }

  private async confioFetch(path: string, options: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(30000),
    })

    const text = await response.text()
    const body = text ? JSON.parse(text) : {}
    if (!response.ok) {
      throw new Error(`ConfioPagos error ${response.status}: ${JSON.stringify(body)}`)
    }
    return body
  }

  /**
   * Crear un pago en ConfioPagos. Devuelve el link de pago (`url`) y el
   * nombre del recurso (`name`) como `providerPaymentId`.
   */
  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    this.ensureConfigured()

    const buyer = this.resolveBuyer(params)
    const description =
      params.purpose === 'plan_purchase'
        ? `Suscripción plan ${params.purposeId || ''}`.trim()
        : params.purpose === 'wallet_recharge'
          ? 'Recarga de wallet Cubiko'
          : 'Pago de servicio Cubiko'

    const body = {
      amountCents: Math.round(params.amount * 100),
      currencyCode: params.currency,
      title: 'Cubiko',
      description,
      buyer,
      // correlationId = nuestro paymentId, para resolver el pago en el webhook.
      correlationId: params.metadata?.paymentId || '',
      paymentType: 'SERVICE',
      redirectUri: params.successUrl || undefined,
      metadata: this.stringifyMetadata(params.metadata),
    }

    const resp = await this.confioFetch(`/stores/${this.storeId}/payments`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    logger.log('info', `ConfioProvider: pago creado ${resp.name} (${resp.url})`)

    return {
      providerPaymentId: resp.name,
      checkoutUrl: resp.url,
      status: 'pending',
    }
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    this.ensureConfigured()

    // `providerPaymentId` suele ser el resource name completo (`stores/{id}/payments/{ulid}`);
    // si ya viene así, se usa relativo a la base; si no, se compone la ruta.
    const path = providerPaymentId.startsWith('stores/')
      ? `/${providerPaymentId}`
      : `/stores/${this.storeId}/payments/${providerPaymentId}`
    const resp = await this.confioFetch(path, { method: 'GET' })

    return {
      status: ConfioProvider.mapStatus(resp.status),
      paidAt: resp.completedAt ? new Date(resp.completedAt) : undefined,
      metadata: { confioStatus: resp.status, paymentMethod: resp.paymentMethod },
    }
  }

  /**
   * ConfioPagos no expone reembolsos en este flujo de integración.
   */
  async refundPayment(_providerPaymentId: string, _amount?: number): Promise<RefundResult> {
    throw new Error('ConfioPagos no soporta reembolsos automáticos en esta integración')
  }

  /**
   * El recurrente se maneja re-emitiendo un link de pago cada período
   * (TasksService.issueExternalCharge); no hay suscripción nativa en este flujo.
   */
  async createSubscription(_params: CreateSubscriptionParams): Promise<SubscriptionResult> {
    throw new Error('ConfioPagos one-shot: usar createCheckout por período, no createSubscription')
  }

  async cancelSubscription(_providerSubscriptionId: string): Promise<void> {
    // Nada que cancelar: se deja de emitir links de pago.
    logger.log('info', 'ConfioProvider: suscripción cancelada (se dejan de emitir links)')
  }

  async savePaymentMethod(_params: SaveMethodParams): Promise<{ setupUrl: string }> {
    throw new Error('ConfioPagos no soporta guardar métodos de pago')
  }

  async removePaymentMethod(_providerMethodId: string): Promise<void> {
    throw new Error('ConfioPagos no soporta métodos de pago')
  }

  /**
   * ConfioPagos valida el webhook con el mismo access token en el header
   * Authorization: Bearer — no hay secreto de firma separado. Aquí `signature`
   * es el token recibido. Comparación en tiempo constante.
   */
  validateWebhookSignature(_payload: Buffer, signature: string): boolean {
    if (!this.accessToken) {
      // Sin token configurado: solo permitir fuera de producción.
      const isProd = process.env.GO_ENV === 'production' || process.env.NODE_ENV === 'production'
      if (isProd) {
        logger.log('error', 'ConfioProvider: access token no configurado en producción — webhook rechazado')
        return false
      }
      logger.log('warn', 'ConfioProvider: access token no configurado, validación de webhook omitida (solo dev)')
      return true
    }

    const received = Buffer.from(signature || '')
    const expected = Buffer.from(this.accessToken)
    if (received.length !== expected.length) return false
    return timingSafeEqual(received, expected)
  }

  /**
   * Mapea un estado crudo de ConfioPagos a nuestro estado interno de pago.
   */
  static mapStatus(confioStatus: string): PaymentStatusResult['status'] {
    switch (confioStatus) {
      case 'FUNDED':
      case 'DELIVERING':
      case 'APPROVED':
        return 'completed'
      case 'PAYMENT_IN_PROGRESS':
      case 'UNDER_REVIEW':
      case 'DISPUTED':
        return 'processing'
      case 'REFUNDED':
        return 'refunded'
      case 'AWAITING_PAYMENT':
        return 'pending'
      case 'EXPIRED':
      case 'CANCELED':
      case 'FAILED':
        return 'failed'
      default:
        return 'pending'
    }
  }

  /** True si el estado de ConfioPagos representa un pago exitoso. */
  static isCompleted(confioStatus: string): boolean {
    return confioStatus === 'FUNDED' || confioStatus === 'DELIVERING' || confioStatus === 'APPROVED'
  }

  /**
   * ConfioPagos exige un comprador con email y teléfono E.164 (+57…).
   * Toma los datos de `metadata.buyer` si vienen; si no, usa fallbacks
   * configurables (para cobros emitidos por el cron sin contexto de usuario).
   */
  private resolveBuyer(params: CreateCheckoutParams) {
    const b = params.metadata?.buyer || {}
    return {
      firstName: b.firstName || 'Cliente',
      lastName: b.lastName || 'Cubiko',
      email: b.email || process.env.CONFIO_FALLBACK_EMAIL || 'pagos@cubiko.co',
      phoneNumber: ConfioProvider.normalizeColombianPhone(b.phoneNumber),
    }
  }

  /** Metadata de ConfioPagos debe ser map<string,string>. */
  private stringifyMetadata(metadata?: Record<string, any>): Record<string, string> | undefined {
    if (!metadata) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(metadata)) {
      if (k === 'buyer') continue
      if (v === undefined || v === null) continue
      out[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    return Object.keys(out).length ? out : undefined
  }

  /**
   * Normaliza un teléfono colombiano a E.164 (+57XXXXXXXXXX). Fallback al
   * ejemplo de la documentación de ConfioPagos cuando falta o es inválido.
   */
  static normalizeColombianPhone(raw?: string): string {
    const fallback = '+573215786325' // de la documentación de ConfioPagos
    let phone = (raw || '').trim()
    if (!phone) return fallback
    if (phone.startsWith('+57') && phone.length >= 12) return phone
    phone = phone.replace(/^\+/, '')
    if (phone.length === 10 && phone[0] === '3') return '+57' + phone
    if (phone.length === 12 && phone.startsWith('57')) return '+' + phone
    return fallback
  }
}
