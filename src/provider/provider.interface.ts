/**
 * Interfaz común para todos los proveedores de pago.
 * Stripe, MercadoPago y Dropi implementan esta interfaz.
 */

export interface CreateCheckoutParams {
  amount: number
  currency: string
  brandId: string
  userId: string
  purpose: string
  purposeId?: string
  successUrl?: string
  cancelUrl?: string
  metadata?: Record<string, any>
}

export interface CheckoutResult {
  providerPaymentId: string
  checkoutUrl: string
  status: string
}

export interface PaymentStatusResult {
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'refunded'
  paidAt?: Date
  metadata?: Record<string, any>
}

export interface RefundResult {
  providerRefundId: string
  status: 'pending' | 'completed' | 'failed'
  amount: number
}

export interface CreateSubscriptionParams {
  brandId: string
  userId: string
  planSlug: string
  priceAmount: number
  currency: string
  paymentMethodId?: string
  trialDays?: number
  metadata?: Record<string, any>
}

export interface SubscriptionResult {
  providerSubscriptionId: string
  status: string
  currentPeriodStart: Date
  currentPeriodEnd: Date
}

export interface SaveMethodParams {
  brandId: string
  userId: string
  successUrl?: string
  cancelUrl?: string
}

export interface PaymentMethodResult {
  providerMethodId: string
  type: string
  last4?: string
  brand?: string
  expiryMonth?: number
  expiryYear?: number
}

export interface PaymentProvider {
  readonly name: string

  // Pagos
  createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult>
  getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult>
  refundPayment(providerPaymentId: string, amount?: number): Promise<RefundResult>

  // Suscripciones
  createSubscription(params: CreateSubscriptionParams): Promise<SubscriptionResult>
  cancelSubscription(providerSubscriptionId: string): Promise<void>

  // Métodos de pago
  savePaymentMethod(params: SaveMethodParams): Promise<{ setupUrl: string }>
  removePaymentMethod(providerMethodId: string): Promise<void>

  // Webhooks
  validateWebhookSignature(payload: Buffer, signature: string): boolean
}
