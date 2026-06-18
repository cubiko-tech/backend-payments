import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'

import { WalletService } from '../wallet/wallet.service'
import { InvoiceService } from '../invoice/invoice.service'
import { SubscriptionService } from '../subscription/subscription.service'
import { AuditService } from '../audit/audit.service'
import { TaxService } from '../tax/tax.service'
import { DianService } from '../dian/dian.service'
import { ProviderFactory } from '../provider/provider.factory'
import { EventBusService } from '../event-bus/event-bus.service'

import { Payment, PaymentStatus, PaymentProvider, PaymentPurpose } from '../payment/entities/payment.entity'
import { PaymentAttempt, AttemptStatus } from '../payment/entities/paymentAttempt.entity'
import { Subscription, SubscriptionStatus, SubscriptionProvider } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'
import { Wallet } from '../wallet/entities/wallet.entity'
import { InvoiceStatus } from '../invoice/entities/invoice.entity'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'

import { ClientRolesService } from '../client/client-roles.service'
import { EnterprisePricingService } from '../subscription/enterprise-pricing.service'
import { ProviderConfigService } from '../provider/provider-config.service'
import { RequestException } from '../shared/exception/request.exception'
import { logger as winstonLogger } from '../shared/logger/logger'

/**
 * Servicio orquestador de checkout.
 *
 * Coordina el flujo completo de pago de punta a punta:
 * 1. Validar datos y calcular impuestos
 * 2. Crear registro de pago
 * 3. Procesar pago (wallet interna o redirect a Stripe/MP/Dropi)
 * 4. Si es pago de plan → crear/renovar suscripción
 * 5. Generar factura con items e impuestos
 * 6. Enviar factura a la DIAN
 * 7. Asignar plan en backend-roles
 * 8. Registrar en audit log
 */

export interface CheckoutRequest {
  brandId: string
  userId: string
  purpose: 'plan_purchase' | 'wallet_recharge' | 'service_payment'
  provider: 'wallet' | 'stripe' | 'mercadopago' | 'dropi'
  // Para plan_purchase
  planSlug?: string
  // Para wallet_recharge / service_payment
  amount?: number
  currency?: string
  walletId?: string
  // URLs de redirect (Stripe/MP)
  successUrl?: string
  cancelUrl?: string
}

export interface CheckoutResult {
  paymentId: string
  status: string
  checkoutUrl?: string      // Solo si provider es Stripe/MP
  subscriptionId?: string   // Solo si purpose es plan_purchase
  invoiceId?: string        // Solo si el pago fue inmediato
}

@Injectable()
export class CheckoutService {
  private readonly log = new Logger(CheckoutService.name)

  constructor(
    @InjectRepository(Payment, 'DBWrite')
    private paymentRepo: Repository<Payment>,
    @InjectRepository(PaymentAttempt, 'DBWrite')
    private attemptRepo: Repository<PaymentAttempt>,
    @InjectRepository(Subscription, 'DBWrite')
    private subscriptionRepo: Repository<Subscription>,
    @InjectRepository(SubscriptionEvent, 'DBWrite')
    private subscriptionEventRepo: Repository<SubscriptionEvent>,
    @InjectRepository(BillingProfile, 'DBRead')
    private billingProfileRepo: Repository<BillingProfile>,
    @InjectDataSource('DBWrite')
    private dataSource: DataSource,
    private walletService: WalletService,
    private invoiceService: InvoiceService,
    private subscriptionService: SubscriptionService,
    private auditService: AuditService,
    private taxService: TaxService,
    private dianService: DianService,
    private providerFactory: ProviderFactory,
    private eventBus: EventBusService,
    private clientRoles: ClientRolesService,
    private enterprisePricing: EnterprisePricingService,
    private providerConfig: ProviderConfigService,
  ) {}

  /**
   * Flujo principal de checkout.
   */
  async processCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    // 0. Validar que el proveedor esté disponible para el país de la marca
    if (req.provider !== 'wallet') {
      const country = await this.getBrandCountry(req.brandId)
      const available = await this.providerConfig.isProviderAvailable(country, req.provider)
      if (!available) {
        throw new RequestException({
          code: 'PROVIDER_NOT_AVAILABLE',
          message: `Proveedor '${req.provider}' no disponible para el país ${country}`,
        })
      }
    }

    // 1. Validar y calcular
    const { amount, currency } = await this.resolveAmountAndCurrency(req)
    const tax = await this.taxService.getTaxForCountry(
      await this.getBrandCountry(req.brandId),
    )
    const taxAmount = tax.taxRate > 0 && !tax.isInclusive
      ? Math.round(amount * tax.taxRate * 100) / 100
      : 0
    const totalAmount = amount + taxAmount

    // 2. Crear registro de pago
    const payment = this.paymentRepo.create({
      brandId: req.brandId,
      userId: req.userId,
      walletId: req.walletId || null,
      provider: req.provider as PaymentProvider,
      amount: totalAmount,
      currency,
      status: PaymentStatus.PENDING,
      purpose: req.purpose as PaymentPurpose,
      purposeId: req.planSlug || null,
    })
    await this.paymentRepo.save(payment)

    // 3. Procesar según provider
    if (req.provider === 'wallet') {
      return this.processWalletPayment(payment, req, amount, taxAmount, currency, tax)
    } else {
      return this.processExternalPayment(payment, req, totalAmount, currency)
    }
  }

  /**
   * Pago con wallet interna — inmediato.
   */
  private async processWalletPayment(
    payment: Payment,
    req: CheckoutRequest,
    subtotal: number,
    taxAmount: number,
    currency: string,
    tax: any,
  ): Promise<CheckoutResult> {
    const totalAmount = subtotal + taxAmount

    // Registrar intento
    await this.attemptRepo.save(this.attemptRepo.create({
      paymentId: payment.id,
      attemptNumber: 1,
      provider: 'wallet',
      status: AttemptStatus.SUCCESS,
      amount: totalAmount,
      attemptedAt: new Date(),
    }))

    try {
      // Debitar wallet (atómico con pessimistic lock)
      await this.walletService.debit(req.walletId, totalAmount, {
        brandId: req.brandId,
        category: req.purpose === 'plan_purchase' ? 'plan_payment' : 'service_payment',
        description: req.purpose === 'plan_purchase'
          ? `Pago plan ${req.planSlug}`
          : 'Pago de servicio',
        referenceType: 'payment',
        referenceId: payment.id,
      })
    } catch (error) {
      // Saldo insuficiente u otro error
      payment.status = PaymentStatus.FAILED
      payment.failureReason = error.message
      await this.paymentRepo.save(payment)

      await this.attemptRepo.save(this.attemptRepo.create({
        paymentId: payment.id,
        attemptNumber: 1,
        provider: 'wallet',
        status: AttemptStatus.FAILED,
        amount: totalAmount,
        providerResponseMessage: error.message,
        attemptedAt: new Date(),
      }))

      throw new RequestException({
        code: 'INSUFFICIENT_BALANCE',
        message: error.message,
      })
    }

    // Marcar pago como completado
    payment.status = PaymentStatus.COMPLETED
    payment.paidAt = new Date()
    await this.paymentRepo.save(payment)

    const result: CheckoutResult = {
      paymentId: payment.id,
      status: 'completed',
    }

    // Si es compra de plan → crear/renovar suscripción
    if (req.purpose === 'plan_purchase' && req.planSlug) {
      const sub = await this.createOrRenewSubscription(req, payment, currency)
      result.subscriptionId = sub.id

      // Asignar plan en backend-roles
      await this.assignPlanInRoles(req.brandId, req.planSlug)
    }

    // Generar factura
    const invoice = await this.generateInvoice(payment, req, subtotal, taxAmount, currency, tax)
    result.invoiceId = invoice.id

    // Enviar a DIAN (async, no bloquea)
    this.sendToDianAsync(invoice.id)

    // Audit
    await this.auditService.log(
      req.userId,
      'checkout_completed',
      'payment',
      payment.id,
      { purpose: req.purpose, planSlug: req.planSlug, amount: totalAmount, provider: 'wallet' },
      `Checkout completado: ${req.purpose} por ${currency} ${totalAmount}`,
    )

    // Publicar evento en Redis Streams
    this.eventBus.publishPaymentCompleted({
      brandId: req.brandId,
      paymentId: payment.id,
      amount: String(subtotal + taxAmount),
      currency,
      purpose: req.purpose,
      planSlug: req.planSlug,
    })

    // Notificar al usuario
    this.eventBus.notifyPaymentSuccess(req.brandId, payment.id, String(subtotal + taxAmount), currency)
    if (invoice) {
      this.eventBus.notifyInvoiceReady(req.brandId, invoice.id, invoice.invoiceNumber)
    }

    this.log.log(`Checkout completado: payment=${payment.id} brand=${req.brandId} plan=${req.planSlug}`)
    return result
  }

  /**
   * Pago con Stripe/MercadoPago/Dropi — redirección.
   */
  private async processExternalPayment(
    payment: Payment,
    req: CheckoutRequest,
    totalAmount: number,
    currency: string,
  ): Promise<CheckoutResult> {
    try {
      const provider = this.providerFactory.getProvider(req.provider)
      const checkout = await provider.createCheckout({
        amount: totalAmount,
        currency,
        brandId: req.brandId,
        userId: req.userId,
        purpose: req.purpose,
        purposeId: req.planSlug,
        successUrl: req.successUrl,
        cancelUrl: req.cancelUrl,
        metadata: { paymentId: payment.id },
      })

      // Actualizar pago con datos del provider
      payment.providerPaymentId = checkout.providerPaymentId
      payment.checkoutUrl = checkout.checkoutUrl
      payment.expiresAt = new Date(Date.now() + parseInt(process.env.CHECKOUT_EXPIRY_HOURS || '24') * 3600000)
      await this.paymentRepo.save(payment)

      // Registrar intento
      await this.attemptRepo.save(this.attemptRepo.create({
        paymentId: payment.id,
        attemptNumber: 1,
        provider: req.provider,
        status: AttemptStatus.SUCCESS,
        amount: totalAmount,
        attemptedAt: new Date(),
        metadata: { providerPaymentId: checkout.providerPaymentId },
      }))

      this.log.log(`Checkout externo creado: payment=${payment.id} provider=${req.provider}`)

      return {
        paymentId: payment.id,
        status: 'pending',
        checkoutUrl: checkout.checkoutUrl,
      }
    } catch (error) {
      payment.status = PaymentStatus.FAILED
      payment.failureReason = error.message
      await this.paymentRepo.save(payment)

      throw new RequestException({
        code: 'PROVIDER_ERROR',
        message: `Error con ${req.provider}: ${error.message}`,
      })
    }
  }

  /**
   * Completar pago externo (llamado desde webhook).
   * Este es el flujo que ejecuta el webhook cuando Stripe/MP/Dropi confirma el pago.
   */
  async completeExternalPayment(paymentId: string, providerData?: any): Promise<void> {
    const payment = await this.paymentRepo.findOne({ where: { id: paymentId } })
    if (!payment || payment.status === PaymentStatus.COMPLETED) return

    payment.status = PaymentStatus.COMPLETED
    payment.paidAt = new Date()
    if (providerData) {
      payment.metadata = { ...payment.metadata, providerData }
    }
    await this.paymentRepo.save(payment)

    // Calcular impuestos para factura
    const country = await this.getBrandCountry(payment.brandId)
    const tax = await this.taxService.getTaxForCountry(country)
    const totalAmount = parseFloat(String(payment.amount))
    const taxAmount = tax.taxRate > 0 && !tax.isInclusive
      ? Math.round(totalAmount * tax.taxRate / (1 + tax.taxRate) * 100) / 100
      : 0
    const subtotal = totalAmount - taxAmount

    // Si es compra de plan → crear/renovar suscripción
    if (payment.purpose === PaymentPurpose.PLAN_PURCHASE && payment.purposeId) {
      await this.createOrRenewSubscription(
        {
          brandId: payment.brandId,
          userId: payment.userId,
          provider: payment.provider as any,
          purpose: 'plan_purchase',
          planSlug: payment.purposeId,
          walletId: payment.walletId,
        },
        payment,
        payment.currency,
      )
      await this.assignPlanInRoles(payment.brandId, payment.purposeId)
    }

    // Si es recarga de wallet → acreditar
    if (payment.purpose === PaymentPurpose.WALLET_RECHARGE && payment.walletId) {
      await this.walletService.credit(payment.walletId, totalAmount, {
        brandId: payment.brandId,
        category: 'recharge',
        description: `Recarga via ${payment.provider}`,
        referenceType: 'payment',
        referenceId: payment.id,
      })
    }

    // Generar factura
    const invoice = await this.generateInvoice(
      payment,
      {
        brandId: payment.brandId,
        userId: payment.userId,
        purpose: payment.purpose as any,
        planSlug: payment.purposeId,
        provider: payment.provider as any,
      },
      subtotal,
      taxAmount,
      payment.currency,
      tax,
    )

    this.sendToDianAsync(invoice.id)

    await this.auditService.log(
      'system',
      'external_payment_completed',
      'payment',
      payment.id,
      { provider: payment.provider, amount: totalAmount },
      `Pago externo completado via ${payment.provider}`,
    )

    // Publicar evento en Redis Streams
    this.eventBus.publishPaymentCompleted({
      brandId: payment.brandId,
      paymentId: payment.id,
      amount: String(payment.amount),
      currency: payment.currency,
      purpose: payment.purpose,
      planSlug: payment.purposeId,
    })

    // Notificar al usuario
    this.eventBus.notifyPaymentSuccess(payment.brandId, payment.id, String(payment.amount), payment.currency)
    if (invoice) {
      this.eventBus.notifyInvoiceReady(payment.brandId, invoice.id, invoice.invoiceNumber)
    }

    this.log.log(`Pago externo completado: payment=${payment.id} brand=${payment.brandId}`)
  }

  // =============================================================
  // Helpers
  // =============================================================

  /**
   * Resolver monto y moneda según el tipo de checkout.
   */
  private async resolveAmountAndCurrency(req: CheckoutRequest): Promise<{ amount: number; currency: string }> {
    if (req.purpose === 'plan_purchase' && req.planSlug) {
      const currency = req.currency || 'COP'

      // Para plan enterprise, verificar si hay precio personalizado
      if (req.planSlug === 'enterprise' && req.brandId) {
        const customPricing = await this.enterprisePricing.getForBrand(req.brandId)
        if (customPricing && customPricing.currency === currency) {
          return { amount: Number(customPricing.monthlyPrice), currency }
        }
      }

      // Precio estándar desde backend-roles
      const price = await this.clientRoles.getPlanPrice(req.planSlug, currency)
      if (price === null) {
        throw new RequestException({ code: 'INVALID_PLAN', message: `Plan '${req.planSlug}' no disponible en moneda '${currency}'` })
      }
      return { amount: price, currency }
    }

    if (!req.amount || !req.currency) {
      throw new RequestException({ code: 'MISSING_AMOUNT', message: 'Monto y moneda requeridos' })
    }

    return { amount: req.amount, currency: req.currency }
  }

  /**
   * Crear o renovar suscripción.
   */
  private async createOrRenewSubscription(
    req: CheckoutRequest,
    payment: Payment,
    currency: string,
  ): Promise<Subscription> {
    const now = new Date()
    const periodEnd = new Date()
    periodEnd.setDate(periodEnd.getDate() + 30)

    // Buscar suscripción existente
    let subscription = await this.subscriptionRepo.findOne({
      where: { brandId: req.brandId },
    })

    if (subscription) {
      // Renovar/cambiar plan
      const fromPlan = subscription.planSlug
      const fromStatus = subscription.status

      subscription.planSlug = req.planSlug
      subscription.status = SubscriptionStatus.ACTIVE
      subscription.provider = req.provider as SubscriptionProvider
      subscription.walletId = req.walletId || subscription.walletId
      subscription.currentPeriodStart = now
      subscription.currentPeriodEnd = periodEnd
      subscription.nextBillingDate = periodEnd
      subscription.lastPaymentId = payment.id
      subscription.retryCount = 0
      subscription.cancelledAt = null
      subscription.cancelReason = null
      subscription.autoRenew = true

      await this.subscriptionRepo.save(subscription)

      // Registrar evento
      const eventType = fromPlan !== req.planSlug
        ? SubscriptionEventType.PLAN_CHANGED
        : SubscriptionEventType.RENEWED

      await this.subscriptionEventRepo.save(this.subscriptionEventRepo.create({
        subscriptionId: subscription.id,
        eventType,
        fromPlanSlug: fromPlan,
        toPlanSlug: req.planSlug,
        fromStatus,
        toStatus: SubscriptionStatus.ACTIVE,
        triggeredBy: req.userId,
        paymentId: payment.id,
        reason: eventType === SubscriptionEventType.PLAN_CHANGED
          ? `Cambio de plan ${fromPlan} → ${req.planSlug}`
          : 'Renovación por pago',
      }))
    } else {
      // Crear nueva
      subscription = this.subscriptionRepo.create({
        brandId: req.brandId,
        userId: req.userId,
        planSlug: req.planSlug,
        status: SubscriptionStatus.ACTIVE,
        provider: req.provider as SubscriptionProvider,
        walletId: req.walletId || null,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        lastPaymentId: payment.id,
        autoRenew: true,
      })
      await this.subscriptionRepo.save(subscription)

      await this.subscriptionEventRepo.save(this.subscriptionEventRepo.create({
        subscriptionId: subscription.id,
        eventType: SubscriptionEventType.CREATED,
        toPlanSlug: req.planSlug,
        toStatus: SubscriptionStatus.ACTIVE,
        triggeredBy: req.userId,
        paymentId: payment.id,
      }))
    }

    return subscription
  }

  /**
   * Generar factura con items e impuestos.
   */
  private async generateInvoice(
    payment: Payment,
    req: any,
    subtotal: number,
    taxAmount: number,
    currency: string,
    tax: any,
  ): Promise<any> {
    const billingProfile = await this.billingProfileRepo.findOne({
      where: { brandId: payment.brandId },
    })

    const invoiceNumber = `${process.env.INVOICE_PREFIX || 'CK'}-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`

    const items = []

    if (req.purpose === 'plan_purchase') {
      items.push({
        description: `Plan ${req.planSlug} — Suscripción mensual Cubiko`,
        quantity: 1,
        unitPrice: subtotal,
        subtotal,
        taxRate: tax.taxRate || 0,
        taxAmount,
        total: subtotal + taxAmount,
        productType: 'plan',
        referenceType: 'subscription',
        referenceId: req.planSlug,
      })
    } else if (req.purpose === 'wallet_recharge') {
      items.push({
        description: `Recarga de wallet via ${payment.provider}`,
        quantity: 1,
        unitPrice: subtotal,
        subtotal,
        taxRate: tax.taxRate || 0,
        taxAmount,
        total: subtotal + taxAmount,
        productType: 'recharge',
        referenceType: 'payment',
        referenceId: payment.id,
      })
    } else {
      items.push({
        description: 'Pago de servicio Cubiko',
        quantity: 1,
        unitPrice: subtotal,
        subtotal,
        taxRate: tax.taxRate || 0,
        taxAmount,
        total: subtotal + taxAmount,
        productType: 'service',
        referenceType: 'payment',
        referenceId: payment.id,
      })
    }

    const result = await this.invoiceService.create({
      brandId: payment.brandId,
      paymentId: payment.id,
      billingProfileId: billingProfile?.id || null,
      invoiceNumber,
      subtotal,
      taxTotal: taxAmount,
      total: subtotal + taxAmount,
      currency,
      status: InvoiceStatus.PAID,
      issuedAt: new Date(),
      paidAt: new Date(),
      items,
    })

    return result.data
  }

  /**
   * Enviar factura a DIAN en background (no bloquea el checkout).
   */
  private sendToDianAsync(invoiceId: string) {
    if (!this.dianService.isConfigured()) return

    // Fire and forget — no bloquea el response al usuario
    this.dianService.sendInvoice(invoiceId).catch((error) => {
      winstonLogger.log('error', `Error enviando factura ${invoiceId} a DIAN: ${error.message}`)
    })
  }

  /**
   * Asignar plan a la marca en backend-roles con expiresAt.
   * Calcula expiresAt = currentPeriodEnd de la suscripción (30 días).
   */
  private async assignPlanInRoles(brandId: string, planSlug: string) {
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 30)
    await this.clientRoles.assignPlanToBrand(brandId, planSlug, expiresAt)
  }

  /**
   * Obtener país de la marca (para cálculo de impuestos).
   */
  private async getBrandCountry(brandId: string): Promise<string> {
    const profile = await this.billingProfileRepo.findOne({
      where: { brandId },
    })
    return profile?.country || 'CO' // Default Colombia
  }
}
