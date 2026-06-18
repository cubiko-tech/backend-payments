import { Injectable } from '@nestjs/common'
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
 * Implementación de MercadoPago como proveedor de pagos.
 * Soporta: tarjetas, PSE, Nequi, transferencia bancaria.
 *
 * Documentación: https://www.mercadopago.com.co/developers/es/reference
 */
@Injectable()
export class MercadoPagoProvider implements PaymentProvider {
  readonly name = 'mercadopago'
  private accessToken: string | null = null
  private baseUrl = 'https://api.mercadopago.com'

  constructor() {
    const token = process.env.MP_ACCESS_TOKEN
    if (token && token !== 'APP_USR-CHANGEME') {
      this.accessToken = token
      logger.log('info', 'MercadoPagoProvider: inicializado correctamente')
    } else {
      logger.log('warn', 'MercadoPagoProvider: MP_ACCESS_TOKEN no configurado')
    }
  }

  private ensureConfigured() {
    if (!this.accessToken) {
      throw new Error('MercadoPago no configurado. Configure MP_ACCESS_TOKEN en .env')
    }
  }

  private async mpFetch(path: string, options: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(15000),
    })

    const body = await response.json()
    if (!response.ok) {
      throw new Error(`MercadoPago error: ${body.message || response.statusText}`)
    }
    return body
  }

  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    this.ensureConfigured()

    const preference = await this.mpFetch('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            title: params.purpose === 'plan_purchase'
              ? `Plan ${params.purposeId || ''}`
              : params.purpose === 'wallet_recharge'
                ? 'Recarga de wallet'
                : 'Pago de servicio',
            quantity: 1,
            unit_price: params.amount,
            currency_id: params.currency.toUpperCase(),
          },
        ],
        metadata: {
          brand_id: params.brandId,
          user_id: params.userId,
          purpose: params.purpose,
          purpose_id: params.purposeId || '',
        },
        back_urls: {
          success: params.successUrl || `https://${process.env.DOMAIN}/payment/success`,
          failure: params.cancelUrl || `https://${process.env.DOMAIN}/payment/failure`,
          pending: `https://${process.env.DOMAIN}/payment/pending`,
        },
        auto_return: 'approved',
        external_reference: `${params.brandId}:${params.purpose}:${Date.now()}`,
        notification_url: `https://${process.env.SERVER}/webhook/mercadopago`,
        payment_methods: {
          excluded_payment_types: [],
          installments: 1,
        },
      }),
    })

    return {
      providerPaymentId: preference.id,
      checkoutUrl: preference.init_point,
      status: 'pending',
    }
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    this.ensureConfigured()

    // providerPaymentId puede ser preference_id o payment_id
    // Intentar como payment primero
    try {
      const payment = await this.mpFetch(`/v1/payments/${providerPaymentId}`)

      const statusMap: Record<string, PaymentStatusResult['status']> = {
        approved: 'completed',
        rejected: 'failed',
        pending: 'pending',
        in_process: 'processing',
        refunded: 'refunded',
        cancelled: 'failed',
        charged_back: 'refunded',
      }

      return {
        status: statusMap[payment.status] || 'pending',
        paidAt: payment.date_approved ? new Date(payment.date_approved) : undefined,
        metadata: {
          paymentMethodId: payment.payment_method_id,
          paymentTypeId: payment.payment_type_id,
          statusDetail: payment.status_detail,
          transactionAmount: payment.transaction_amount,
        },
      }
    } catch {
      // Puede que sea un preference_id, buscar pagos asociados
      return { status: 'pending' }
    }
  }

  async refundPayment(providerPaymentId: string, amount?: number): Promise<RefundResult> {
    this.ensureConfigured()

    const body: any = {}
    if (amount) {
      body.amount = amount
    }

    const refund = await this.mpFetch(`/v1/payments/${providerPaymentId}/refunds`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    return {
      providerRefundId: String(refund.id),
      status: refund.status === 'approved' ? 'completed' : 'pending',
      amount: refund.amount || amount || 0,
    }
  }

  async createSubscription(params: CreateSubscriptionParams): Promise<SubscriptionResult> {
    this.ensureConfigured()

    // MercadoPago suscripciones via preapproval
    const preapproval = await this.mpFetch('/preapproval', {
      method: 'POST',
      body: JSON.stringify({
        reason: `Plan ${params.planSlug} - Cubiko`,
        auto_recurring: {
          frequency: 1,
          frequency_type: 'months',
          transaction_amount: params.priceAmount,
          currency_id: params.currency.toUpperCase(),
        },
        back_url: `https://${process.env.DOMAIN}/subscription/success`,
        external_reference: `${params.brandId}:${params.planSlug}`,
        payer_email: params.metadata?.email || '',
        ...(params.trialDays ? {
          free_trial: {
            frequency: params.trialDays,
            frequency_type: 'days',
          },
        } : {}),
      }),
    })

    const now = new Date()
    const periodEnd = new Date()
    periodEnd.setDate(periodEnd.getDate() + 30)

    return {
      providerSubscriptionId: preapproval.id,
      status: 'pending',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    }
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    this.ensureConfigured()

    await this.mpFetch(`/preapproval/${providerSubscriptionId}`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'cancelled' }),
    })
  }

  async savePaymentMethod(_params: SaveMethodParams): Promise<{ setupUrl: string }> {
    // MercadoPago no tiene setup sessions como Stripe
    // Los métodos de pago se guardan al completar un pago
    throw new Error('MercadoPago guarda métodos de pago automáticamente al pagar')
  }

  async removePaymentMethod(_providerMethodId: string): Promise<void> {
    // MercadoPago no expone API para eliminar métodos de pago del customer
    logger.log('warn', 'MercadoPago no soporta eliminación directa de métodos de pago')
  }

  validateWebhookSignature(payload: Buffer, signature: string): boolean {
    // MercadoPago usa x-signature header con ts y v1
    // Formato: ts=TIMESTAMP,v1=HASH
    const secret = process.env.MP_WEBHOOK_SECRET
    if (!secret) return false

    try {
      const parts = signature.split(',')
      const ts = parts.find((p) => p.startsWith('ts='))?.split('=')[1]
      const v1 = parts.find((p) => p.startsWith('v1='))?.split('=')[1]

      if (!ts || !v1) return false

      const { createHmac } = require('crypto')
      const manifest = `id:${JSON.parse(payload.toString()).data?.id};request-id:;ts:${ts};`
      const hmac = createHmac('sha256', secret).update(manifest).digest('hex')

      return hmac === v1
    } catch {
      return false
    }
  }
}
