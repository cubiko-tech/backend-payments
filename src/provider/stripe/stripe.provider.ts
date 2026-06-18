import { Injectable } from '@nestjs/common'
import Stripe from 'stripe'
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

@Injectable()
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe'
  private stripe: Stripe | null = null

  constructor() {
    const secretKey = process.env.STRIPE_SECRET_KEY
    if (secretKey && secretKey !== 'sk_test_CHANGEME') {
      this.stripe = new Stripe(secretKey)
      logger.log('info', 'StripeProvider: inicializado correctamente')
    } else {
      logger.log('warn', 'StripeProvider: STRIPE_SECRET_KEY no configurado')
    }
  }

  private ensureConfigured() {
    if (!this.stripe) {
      throw new Error('Stripe no configurado. Configure STRIPE_SECRET_KEY en .env')
    }
  }

  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    this.ensureConfigured()

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: params.currency.toLowerCase(),
            unit_amount: Math.round(params.amount * 100),
            product_data: {
              name: params.purpose === 'plan_purchase'
                ? `Plan ${params.purposeId || ''}`
                : params.purpose === 'wallet_recharge'
                  ? 'Recarga de wallet'
                  : 'Pago de servicio',
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        brandId: params.brandId,
        userId: params.userId,
        purpose: params.purpose,
        purposeId: params.purposeId || '',
      },
      success_url: params.successUrl || `https://${process.env.DOMAIN}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: params.cancelUrl || `https://${process.env.DOMAIN}/payment/cancel`,
    })

    return {
      providerPaymentId: session.id,
      checkoutUrl: session.url,
      status: 'pending',
    }
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    this.ensureConfigured()

    const session = await this.stripe.checkout.sessions.retrieve(providerPaymentId)

    const statusMap: Record<string, PaymentStatusResult['status']> = {
      complete: 'completed',
      expired: 'failed',
      open: 'pending',
    }

    return {
      status: statusMap[session.status] || 'pending',
      paidAt: session.status === 'complete' ? new Date(session.created * 1000) : undefined,
      metadata: {
        paymentIntent: session.payment_intent,
        customerEmail: session.customer_details?.email,
        amountTotal: session.amount_total,
      },
    }
  }

  async refundPayment(providerPaymentId: string, amount?: number): Promise<RefundResult> {
    this.ensureConfigured()

    const session = await this.stripe.checkout.sessions.retrieve(providerPaymentId)
    const paymentIntentId = session.payment_intent as string

    if (!paymentIntentId) {
      throw new Error('No se encontró payment_intent para esta sesión')
    }

    const refundParams: Stripe.RefundCreateParams = {
      payment_intent: paymentIntentId,
    }
    if (amount) {
      refundParams.amount = Math.round(amount * 100)
    }

    const refund = await this.stripe.refunds.create(refundParams)

    return {
      providerRefundId: refund.id,
      status: refund.status === 'succeeded' ? 'completed' : 'pending',
      amount: refund.amount / 100,
    }
  }

  async createSubscription(params: CreateSubscriptionParams): Promise<SubscriptionResult> {
    this.ensureConfigured()

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: params.currency.toLowerCase(),
            unit_amount: Math.round(params.priceAmount * 100),
            recurring: { interval: 'month' },
            product_data: { name: `Plan ${params.planSlug}` },
          },
          quantity: 1,
        },
      ],
      metadata: {
        brandId: params.brandId,
        userId: params.userId,
        planSlug: params.planSlug,
      },
      subscription_data: {
        trial_period_days: params.trialDays || undefined,
        metadata: { brandId: params.brandId, planSlug: params.planSlug },
      },
      success_url: `https://${process.env.DOMAIN}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://${process.env.DOMAIN}/subscription/cancel`,
    })

    const now = new Date()
    const periodEnd = new Date()
    periodEnd.setDate(periodEnd.getDate() + 30)

    return {
      providerSubscriptionId: session.id,
      status: 'pending',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    }
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    this.ensureConfigured()
    try {
      await this.stripe.subscriptions.cancel(providerSubscriptionId)
    } catch {
      const session = await this.stripe.checkout.sessions.retrieve(providerSubscriptionId)
      if (session.subscription) {
        await this.stripe.subscriptions.cancel(session.subscription as string)
      }
    }
  }

  async savePaymentMethod(params: SaveMethodParams): Promise<{ setupUrl: string }> {
    this.ensureConfigured()

    const session = await this.stripe.checkout.sessions.create({
      mode: 'setup',
      payment_method_types: ['card'],
      metadata: { brandId: params.brandId, userId: params.userId },
      success_url: params.successUrl || `https://${process.env.DOMAIN}/payment-method/success`,
      cancel_url: params.cancelUrl || `https://${process.env.DOMAIN}/payment-method/cancel`,
    })

    return { setupUrl: session.url }
  }

  async removePaymentMethod(providerMethodId: string): Promise<void> {
    this.ensureConfigured()
    await this.stripe.paymentMethods.detach(providerMethodId)
  }

  validateWebhookSignature(payload: Buffer, signature: string): boolean {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    if (!webhookSecret || !this.stripe) return false
    try {
      this.stripe.webhooks.constructEvent(payload, signature, webhookSecret)
      return true
    } catch {
      return false
    }
  }

  /**
   * Construir evento de webhook verificado.
   */
  constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
    this.ensureConfigured()
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET,
    )
  }
}
