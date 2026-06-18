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
 * Implementación de Dropi como proveedor de pagos.
 *
 * Dropi funciona diferente a Stripe/MP:
 * - No tiene checkout sessions
 * - Se le envía un cobro y Dropi lo procesa asincrónicamente
 * - Confirma via webhook cuando el usuario paga
 * - Soporta cobros masivos (batch)
 */
@Injectable()
export class DropiProvider implements PaymentProvider {
  readonly name = 'dropi'
  private apiUrl: string | null = null
  private apiKey: string | null = null

  constructor() {
    const url = process.env.DROPI_API_URL
    const key = process.env.DROPI_API_KEY
    if (url && key && key !== 'CHANGEME') {
      this.apiUrl = url
      this.apiKey = key
      logger.log('info', 'DropiProvider: inicializado correctamente')
    } else {
      logger.log('warn', 'DropiProvider: DROPI_API_URL/DROPI_API_KEY no configurados')
    }
  }

  private ensureConfigured() {
    if (!this.apiUrl || !this.apiKey) {
      throw new Error('Dropi no configurado. Configure DROPI_API_URL y DROPI_API_KEY en .env')
    }
  }

  private async dropiFetch(path: string, options: RequestInit = {}) {
    const response = await fetch(`${this.apiUrl}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(15000),
    })

    const body = await response.json()
    if (!response.ok) {
      throw new Error(`Dropi error: ${body.message || response.statusText}`)
    }
    return body
  }

  /**
   * En Dropi no hay checkout session.
   * Se crea un cobro pendiente que el usuario paga desde su cuenta Dropi.
   */
  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    this.ensureConfigured()

    const charge = await this.dropiFetch('/charges', {
      method: 'POST',
      body: JSON.stringify({
        userId: params.userId,
        brandId: params.brandId,
        amount: params.amount,
        currency: params.currency,
        description: params.purpose === 'plan_purchase'
          ? `Pago plan ${params.purposeId || ''}`
          : params.purpose === 'wallet_recharge'
            ? 'Recarga de wallet Cubiko'
            : 'Pago de servicio Cubiko',
        referenceId: params.metadata?.referenceId || `${params.brandId}:${Date.now()}`,
        callbackUrl: `https://${process.env.SERVER}/webhook/dropi`,
      }),
    })

    return {
      providerPaymentId: charge.id || charge.chargeId,
      checkoutUrl: null, // Dropi no tiene URL de checkout
      status: 'pending',
    }
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    this.ensureConfigured()

    const charge = await this.dropiFetch(`/charges/${providerPaymentId}`)

    const statusMap: Record<string, PaymentStatusResult['status']> = {
      paid: 'completed',
      pending: 'pending',
      rejected: 'failed',
      cancelled: 'failed',
      refunded: 'refunded',
    }

    return {
      status: statusMap[charge.status] || 'pending',
      paidAt: charge.paidAt ? new Date(charge.paidAt) : undefined,
      metadata: {
        dropiStatus: charge.status,
        dropiUserId: charge.userId,
      },
    }
  }

  async refundPayment(providerPaymentId: string, amount?: number): Promise<RefundResult> {
    this.ensureConfigured()

    const refund = await this.dropiFetch(`/charges/${providerPaymentId}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount }),
    })

    return {
      providerRefundId: refund.id || refund.refundId,
      status: refund.status === 'completed' ? 'completed' : 'pending',
      amount: refund.amount || amount || 0,
    }
  }

  /**
   * Dropi no maneja suscripciones recurrentes directamente.
   * Se crean cobros individuales cada periodo via cron (processDropiBatchCharges).
   */
  async createSubscription(params: CreateSubscriptionParams): Promise<SubscriptionResult> {
    // No se crea suscripción en Dropi — se cobra manualmente cada periodo
    const now = new Date()
    const periodEnd = new Date()
    periodEnd.setDate(periodEnd.getDate() + 30)

    return {
      providerSubscriptionId: `dropi-sub-${params.brandId}-${Date.now()}`,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    }
  }

  async cancelSubscription(_providerSubscriptionId: string): Promise<void> {
    // No hay nada que cancelar en Dropi — solo dejamos de enviar cobros
    logger.log('info', 'DropiProvider: suscripción cancelada (se dejan de enviar cobros)')
  }

  async savePaymentMethod(_params: SaveMethodParams): Promise<{ setupUrl: string }> {
    throw new Error('Dropi no soporta guardar métodos de pago')
  }

  async removePaymentMethod(_providerMethodId: string): Promise<void> {
    throw new Error('Dropi no soporta métodos de pago')
  }

  validateWebhookSignature(payload: Buffer, signature: string): boolean {
    const secret = process.env.DROPI_WEBHOOK_SECRET
    if (!secret) return false

    try {
      const { createHmac } = require('crypto')
      const expected = createHmac('sha256', secret).update(payload).digest('hex')
      return expected === signature
    } catch {
      return false
    }
  }

  // ===========================================
  // Métodos específicos de Dropi
  // ===========================================

  /**
   * Enviar cobros masivos a Dropi.
   * Usado por el cron processDropiBatchCharges.
   */
  async batchCharge(charges: Array<{
    userId: string
    brandId: string
    amount: number
    currency: string
    description: string
    referenceId: string
  }>): Promise<Array<{ chargeId: string; status: string }>> {
    this.ensureConfigured()

    const result = await this.dropiFetch('/charges/batch', {
      method: 'POST',
      body: JSON.stringify({ charges }),
    })

    return result.charges || result.results || []
  }

  /**
   * Consultar estado de múltiples cobros.
   */
  async batchStatus(chargeIds: string[]): Promise<Array<{ chargeId: string; status: string; paidAt?: string }>> {
    this.ensureConfigured()

    const result = await this.dropiFetch('/charges/status', {
      method: 'POST',
      body: JSON.stringify({ chargeIds }),
    })

    return result.charges || result.results || []
  }
}
