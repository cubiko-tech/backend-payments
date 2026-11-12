import { Injectable } from '@nestjs/common'
import { createHmac } from 'crypto'
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
import { readWebhookSecret } from '../../shared/env/webhook-secret'
import { timingSafeEqualStrings } from '../confio/confio-webhook-signature'

const MP_STATUS: Record<string, PaymentStatusResult['status']> = {
  approved: 'completed',
  refunded: 'refunded',
  charged_back: 'refunded',
  in_process: 'processing',
  pending: 'processing',
  authorized: 'processing',
}
// A checkout can collect several attempts: what happened to the money outranks a live attempt.
const MP_STATUS_PRECEDENCE = Object.keys(MP_STATUS)

/** A non-2xx answer from Mercado Pago, with its status. */
export class MercadoPagoApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface MercadoPagoNoticePayment {
  status: string
  externalReference: string | null
  transactionAmount: number | null
}

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

    const text = await response.text()
    if (!response.ok) {
      throw new MercadoPagoApiError(
        response.status,
        `MercadoPago error ${response.status}: ${text.slice(0, 300)}`,
      )
    }
    return JSON.parse(text)
  }

  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    this.ensureConfigured()

    const preference = await this.mpFetch('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify({
        items: [
          {
            title:
              params.purpose === 'plan_purchase'
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
        external_reference:
          params.metadata?.paymentId ?? `${params.brandId}:${params.purpose}:${Date.now()}`,
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

  /**
   * Finds the payment by the reference `createCheckout` set: our row keeps the preference id, which
   * has no status of its own. Finding none means only that; it never reads as confirmed.
   * @throws when Mercado Pago gives no usable answer, which says nothing about the payment.
   */
  async getPaymentStatus(
    _providerPaymentId: string,
    paymentId: string,
  ): Promise<PaymentStatusResult> {
    this.ensureConfigured()

    const found = await this.mpFetch(
      `/v1/payments/search?external_reference=${encodeURIComponent(paymentId)}&limit=50`,
    )
    if (!Array.isArray(found?.results)) {
      throw new Error(`MercadoPago search for payment ${paymentId} returned no results list`)
    }

    const deciding = MP_STATUS_PRECEDENCE.find((status) =>
      found.results.some((payment: any) => payment.status === status),
    )
    if (!deciding) {
      return { status: 'pending', metadata: { paymentsFound: found.results.length } }
    }
    const payment = found.results.find((candidate: any) => candidate.status === deciding)
    return {
      status: MP_STATUS[deciding],
      paidAt: payment.date_approved ? new Date(payment.date_approved) : undefined,
      metadata: {
        paymentMethodId: payment.payment_method_id,
        paymentTypeId: payment.payment_type_id,
        statusDetail: payment.status_detail,
        transactionAmount: payment.transaction_amount,
      },
    }
  }

  /**
   * Fetches the payment referenced by a webhook notification (`data.id`) directly from Mercado Pago
   * (`GET /v1/payments/{id}`) so a notice never completes a payment without verifying its live status.
   * @throws when Mercado Pago fails or returns no `status`.
   */
  async getNoticePayment(mpPaymentId: string): Promise<MercadoPagoNoticePayment> {
    this.ensureConfigured()

    const payment = await this.mpFetch(`/v1/payments/${encodeURIComponent(mpPaymentId)}`)
    if (typeof payment?.status !== 'string' || payment.status.trim() === '') {
      throw new Error(`MercadoPago payment ${mpPaymentId} returned no status`)
    }

    const externalReference =
      typeof payment.external_reference === 'string' && payment.external_reference.trim() !== ''
        ? payment.external_reference.trim()
        : null
    // Number(null) and Number('') are 0: an absent amount must stay absent, not read as zero.
    const raw = payment.transaction_amount
    const rawAmount = raw === null || raw === undefined || raw === '' ? NaN : Number(raw)
    const transactionAmount = Number.isFinite(rawAmount) ? rawAmount : null

    return {
      status: payment.status,
      externalReference,
      transactionAmount,
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
        ...(params.trialDays
          ? {
              free_trial: {
                frequency: params.trialDays,
                frequency_type: 'days',
              },
            }
          : {}),
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

  /**
   * Checks the `x-signature` header (`ts=<seconds or ms>,v1=<hex hmac>`): the HMAC of the manifest, compared in
   * constant time, and a `ts` within {@link SIGNATURE_WINDOW_MS} of now. A body without `data.id` is rejected.
   */
  validateWebhookSignature(payload: Buffer, signature: string): boolean {
    const secret = readWebhookSecret('MP_WEBHOOK_SECRET')
    const signed = readSignedFields(payload, signature)
    if (!secret || !signed) return false

    if (Math.abs(Date.now() - tsToMs(signed.ts)) > SIGNATURE_WINDOW_MS) return false

    const manifest = `id:${signed.dataId};request-id:;ts:${signed.ts};`
    const expected = createHmac('sha256', secret).update(manifest).digest('hex')

    return timingSafeEqualStrings(signed.v1, expected)
  }

  /**
   * Deduplication key of a notification whose signature was already validated: built from what is
   * signed (`data.id`, `ts`) plus its unsigned `action`, so `payment.created` and `payment.updated` never collide.
   * @throws Error when the signed fields cannot be read.
   */
  webhookEventId(payload: Buffer, signature: string): string {
    const signed = readSignedFields(payload, signature)
    if (!signed) throw new Error('Mercado Pago notification without signed fields')

    return `mp:${signed.action}:${signed.dataId}:${signed.ts}`
  }
}

/** How far `ts` may be from now, on either side. Assumed by LOC-113; Mercado Pago documents none. */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000

interface SignedFields {
  ts: string
  v1: string
  dataId: string
  action: string
}

/** Reads the header and the body fields the signature covers; `null` when any of them is missing. */
function readSignedFields(payload: Buffer, signature: string): SignedFields | null {
  if (typeof signature !== 'string') return null

  const parts = signature.split(',').map((part) => part.trim())
  const ts = parts.find((p) => p.startsWith('ts='))?.slice(3)
  const v1 = parts.find((p) => p.startsWith('v1='))?.slice(3)
  if (!ts || !/^\d+$/.test(ts) || !v1) return null

  let body: { data?: { id?: unknown }; action?: unknown; type?: unknown } | null
  try {
    body = JSON.parse(payload.toString())
  } catch {
    return null
  }
  const dataId = body?.data?.id
  const action = body?.action ?? body?.type ?? 'unknown'
  if (!isPrimitiveField(dataId) || dataId === '' || !isPrimitiveField(action)) return null

  return { ts, v1, dataId: String(dataId), action: String(action) }
}

/** Only strings and numbers become part of the manifest or the key; `String()` throws on some objects. */
function isPrimitiveField(value: unknown): value is string | number {
  return typeof value === 'string' || typeof value === 'number'
}

/** Mercado Pago shows `ts` both in seconds (10 digits) and in milliseconds (13 digits). */
function tsToMs(ts: string): number {
  return ts.length >= 13 ? Number(ts) : Number(ts) * 1000
}
