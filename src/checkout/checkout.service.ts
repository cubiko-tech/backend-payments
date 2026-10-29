import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'

import { WalletService } from '../wallet/wallet.service'
import { InvoiceService } from '../invoice/invoice.service'
import { SubscriptionService } from '../subscription/subscription.service'
import { AuditService } from '../audit/audit.service'
import { TaxService, isVatCountry } from '../tax/tax.service'
import { DianService } from '../dian/dian.service'
import { ProviderFactory } from '../provider/provider.factory'
import { EventBusService } from '../event-bus/event-bus.service'

import {
  Payment,
  PaymentStatus,
  PaymentProvider,
  PaymentPurpose,
} from '../payment/entities/payment.entity'
import { PaymentAttempt, AttemptStatus } from '../payment/entities/paymentAttempt.entity'
import {
  Subscription,
  SubscriptionStatus,
  SubscriptionProvider,
} from '../subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../subscription/entities/subscriptionEvent.entity'
import { Wallet } from '../wallet/entities/wallet.entity'
import { InvoiceStatus } from '../invoice/entities/invoice.entity'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'

import {
  ClientRolesService,
  PLAN_NOT_FOUND,
  PRICE_NOT_FOUND_FOR_COUNTRY,
  PriceResolutionErrorCode,
} from '../client/client-roles.service'
import {
  ClientPlatformService,
  BRAND_LOOKUP_UNAVAILABLE,
  BRAND_NOT_FOUND,
  BRAND_WITHOUT_COUNTRY,
  BrandCountryErrorCode,
} from '../client/client-platform.service'
import { EnterprisePricingService } from '../subscription/enterprise-pricing.service'
import { ProviderConfigService } from '../provider/provider-config.service'
import { WebhookService } from '../webhook/webhook.service'
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
  provider: 'wallet' | 'stripe' | 'mercadopago' | 'dropi' | 'confio'
  // Para plan_purchase
  planSlug?: string
  // Para wallet_recharge / service_payment
  amount?: number
  currency?: string
  walletId?: string
  // URLs de redirect (Stripe/MP/Confio)
  successUrl?: string
  cancelUrl?: string
  // Datos del comprador (requeridos por ConfioPagos: email + teléfono E.164)
  buyer?: { firstName?: string; lastName?: string; email?: string; phoneNumber?: string }
  idempotencyKey?: string
  /**
   * Renovación emitida por el cron (`TasksService.issueExternalCharge`), NO un alta.
   * Es una bandera EXPLÍCITA del llamador: nunca se deduce de los datos y nunca se
   * acepta por HTTP (el controller la borra). Sólo elige el camino de precios LEGACY
   * —el de hoy— para que el cron no cambie de comportamiento; no relaja el gate de
   * proveedor, ni el impuesto, ni el débito de wallet.
   */
  renewal?: boolean
}

/**
 * Monto y moneda ya resueltos para este checkout.
 *
 * `country` viaja informado SÓLO cuando el precio salió del catálogo por país; es
 * lo que permite gatear al proveedor y calcular el impuesto contra el MISMO país
 * que decidió el precio, en vez de contra el perfil de facturación. Queda vacío en
 * el precio negociado enterprise, en el fallback legacy de la renovación y en los
 * `purpose` que no son compra de plan.
 */
interface ResolvedPricing {
  amount: number
  currency: string
  country?: string
}

export interface CheckoutResult {
  paymentId: string
  status: string
  checkoutUrl?: string // Only when provider is Stripe/MP
  subscriptionId?: string // Only when purpose is plan_purchase
  invoiceId?: string // Only when payment was immediate
  renewal?: 'extended'
  currentPeriodEnd?: Date
}

@Injectable()
export class CheckoutService implements OnModuleInit {
  private readonly log = new Logger(CheckoutService.name)
  private readonly BILLING_PERIOD_DAYS = parseInt(process.env.BILLING_PERIOD_DAYS || '30')
  private readonly inFlightCheckouts = new Map<
    string,
    { fingerprint: string; promise: Promise<CheckoutResult> }
  >()
  private readonly inFlightCompletions = new Set<string>()

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
    private clientPlatform: ClientPlatformService,
    private enterprisePricing: EnterprisePricingService,
    private providerConfig: ProviderConfigService,
    private webhookService: WebhookService,
  ) {}

  /**
   * Registrarse en WebhookService (inyección tardía para evitar dependencia
   * circular Checkout↔Webhook): así los webhooks de pago externo pueden
   * completar el checkout (asignar plan, generar factura, etc.).
   */
  onModuleInit() {
    this.webhookService.setCheckoutService(this)
    this.log.log('CheckoutService registrado en WebhookService')
  }

  /**
   * Flujo principal de checkout.
   */
  async processCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    // 0. El brandId se normaliza UNA sola vez y ANTES de cualquier consulta que lo
    // use (gate de proveedor, `enterprise_pricing`, platform). Devuelve una copia:
    // mutar la request del llamador escondía el efecto y le reescribía el objeto al
    // cron, que nos pasa datos derivados de una fila viva de `subscriptions`.
    const req = this.normalizeRequest(request)
    const idempotencyFingerprint = req.idempotencyKey
      ? this.buildIdempotencyFingerprint(req)
      : undefined

    if (req.idempotencyKey) {
      const existing = await this.paymentRepo.findOne({
        where: { brandId: req.brandId, idempotencyKey: req.idempotencyKey },
      })
      if (existing) {
        return this.resolveExistingIdempotentPayment(existing, req, idempotencyFingerprint)
      }
    }

    // 1. Precio y moneda. En `plan_purchase` los decide el país REGISTRADO de la
    // marca; `country` viene informado SÓLO cuando el precio salió del catálogo por
    // país (no en el precio negociado enterprise ni en el fallback legacy).
    const { amount, currency, country } = await this.resolveAmountAndCurrency(req)

    // 2. El proveedor se valida contra el MISMO país que decidió el precio. Gatear
    // por el perfil de facturación (`|| 'CO'`) mientras el monto viaja en la moneda
    // del país de la marca dejaba pasar un cobro en USD a un proveedor habilitado
    // sólo para CO y nunca validado para esa moneda.
    if (req.provider !== 'wallet') {
      const gateCountry = country || (await this.getBillingCountry(req.brandId))
      const available = await this.providerConfig.isProviderAvailable(gateCountry, req.provider)
      if (!available) {
        throw new RequestException({
          code: 'PROVIDER_NOT_AVAILABLE',
          message: `Proveedor '${req.provider}' no disponible para el país ${gateCountry}`,
        })
      }
    }

    // 3. Pre-validate wallet ownership, non-TKN currency, and currency match
    // before persisting the payment or debiting across any checkout purpose.
    if (req.provider === 'wallet' || req.purpose === 'wallet_recharge' || req.walletId) {
      await this.assertWalletCurrency(req, currency)
    }

    // 4. UN SOLO DUEÑO DEL PAÍS: el que ya decidió el precio. Antes esto se conformaba
    // con `currency !== 'COP'`, que es un PROXY de «hay país del precio» y falla donde
    // más importa: una marca mexicana con precio en COP pagaba 19% de IVA colombiano en
    // vez de su 16%. Si `resolveAmountAndCurrency` resolvió un país, ése manda; el perfil
    // de facturación sólo cubre el alta enterprise, que no trae precio de catálogo.
    //
    // Censo de `tax_config` al 2026-09-01 (base local): CO 19%, MX 16%, US 0% «Sales tax»,
    // las tres activas. O sea que un país con configuración propia YA no cae al 19%, y uno
    // sin fila cae a la rama de 0% + warn que `TaxService` ya tiene: la aceptación («o no
    // lleva impuesto, o falla con un error que lo dice») se cumple sin inventar un error
    // nuevo sobre un endpoint de plata.
    const taxCountry = country || (await this.getBillingCountry(req.brandId))
    const isWalletRecharge = req.purpose === 'wallet_recharge'
    const isWalletConsumption = req.provider === 'wallet' && !isWalletRecharge
    const tax = isWalletRecharge
      ? await this.resolveRechargeTax(taxCountry)
      : await this.taxService.getTaxForCountry(taxCountry)
    const directTaxBreakdown = isWalletConsumption
      ? null
      : this.breakDownTaxInclusiveAmount(amount, tax.taxRate)
    const subtotalAmount = directTaxBreakdown ? directTaxBreakdown.subtotal : amount
    const taxAmount = directTaxBreakdown ? directTaxBreakdown.taxAmount : 0
    const totalAmount = directTaxBreakdown ? directTaxBreakdown.totalAmount : amount

    // 2. Crear registro de pago
    const payment = this.paymentRepo.create({
      brandId: req.brandId,
      userId: req.userId,
      ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
      walletId: req.walletId || null,
      provider: req.provider as PaymentProvider,
      amount: totalAmount,
      currency,
      status: PaymentStatus.PENDING,
      purpose: req.purpose as PaymentPurpose,
      purposeId: req.planSlug || null,
      // El país viaja CON el pago porque el camino externo factura después, en otro
      // request (`completeExternalPayment`), donde `resolveAmountAndCurrency` ya no está.
      // Sin esto, esa factura vuelve a resolver por perfil de facturación y una marca sin
      // perfil cae al 19% colombiano — el bug que esta tarea cierra. Va en `metadata` y no
      // en una columna nueva: es un dato del checkout, no del dominio del pago, y no
      // necesita migración.
      metadata: {
        country: taxCountry,
        ...(!isWalletConsumption
          ? {
              taxRate: tax.taxRate,
              taxName: tax.taxName,
              subtotal: subtotalAmount,
              taxAmount,
              ...(req.buyer ? { buyer: req.buyer } : {}),
            }
          : {}),
        ...(req.idempotencyKey ? { idempotencyFingerprint } : {}),
      },
    })

    const inFlightKey = req.idempotencyKey ? `${req.brandId}:${req.idempotencyKey}` : undefined
    try {
      const savedPayment = await this.paymentRepo.save(payment)
      if (savedPayment?.id && !payment.id) {
        payment.id = savedPayment.id
      }
    } catch (error) {
      if (req.idempotencyKey && this.isUniqueConstraintViolation(error)) {
        return this.handleConcurrentIdempotentCheckout(req, idempotencyFingerprint, inFlightKey)
      }
      throw error
    }

    if (inFlightKey) {
      const executionPromise = this.executeCheckoutPayment(
        payment,
        req,
        subtotalAmount,
        taxAmount,
        totalAmount,
        currency,
        tax,
      )
      this.inFlightCheckouts.set(inFlightKey, {
        fingerprint: idempotencyFingerprint,
        promise: executionPromise,
      })
      try {
        return await executionPromise
      } finally {
        this.inFlightCheckouts.delete(inFlightKey)
      }
    }

    return this.executeCheckoutPayment(
      payment,
      req,
      subtotalAmount,
      taxAmount,
      totalAmount,
      currency,
      tax,
    )
  }

  private executeCheckoutPayment(
    payment: Payment,
    req: CheckoutRequest,
    amount: number,
    taxAmount: number,
    totalAmount: number,
    currency: string,
    tax: any,
  ): Promise<CheckoutResult> {
    if (req.provider === 'wallet') {
      return this.processWalletPayment(payment, req, amount, taxAmount, currency, tax)
    }
    return this.processExternalPayment(payment, req, totalAmount, currency)
  }

  /**
   * Pago con wallet interna — inmediato.
   *
   * Wallet consumptions debit the published price (`taxAmount = 0`) and do not emit
   * a tax invoice because VAT was already caused and invoiced on the wallet recharge.
   */
  private async processWalletPayment(
    payment: Payment,
    req: CheckoutRequest,
    subtotal: number,
    taxAmount: number,
    currency: string,
    _tax?: any,
  ): Promise<CheckoutResult> {
    const totalAmount = Math.round((subtotal + taxAmount) * 100) / 100

    // Registrar intento
    await this.attemptRepo.save(
      this.attemptRepo.create({
        paymentId: payment.id,
        attemptNumber: 1,
        provider: 'wallet',
        status: AttemptStatus.SUCCESS,
        amount: totalAmount,
        attemptedAt: new Date(),
      }),
    )

    try {
      const debitResult = await this.walletService.debit(
        req.walletId,
        totalAmount,
        {
          brandId: req.brandId,
          category: req.purpose === 'plan_purchase' ? 'plan_payment' : 'service_payment',
          description:
            req.purpose === 'plan_purchase' ? `Pago plan ${req.planSlug}` : 'Pago de servicio',
          referenceType: 'payment',
          referenceId: payment.id,
          idempotencyKey: `payment:${payment.id}:debit`,
        },
        currency,
      )
      if (
        debitResult &&
        typeof debitResult === 'object' &&
        'error' in debitResult &&
        (debitResult as any).error
      ) {
        throw new Error((debitResult as any).error)
      }
    } catch (error) {
      payment.status = PaymentStatus.FAILED
      payment.failureReason = error.message
      await this.paymentRepo.save(payment)

      await this.attemptRepo.save(
        this.attemptRepo.create({
          paymentId: payment.id,
          attemptNumber: 1,
          provider: 'wallet',
          status: AttemptStatus.FAILED,
          amount: totalAmount,
          providerResponseMessage: error.message,
          attemptedAt: new Date(),
        }),
      )

      if (error instanceof RequestException) {
        throw error
      }

      throw new RequestException(
        {
          code: 'WALLET_DEBIT_FAILED',
          message: error.message,
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
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
      const { subscription: sub, extended } = await this.createOrRenewSubscription(req, payment)
      result.subscriptionId = sub.id
      if (extended && sub.currentPeriodEnd) {
        result.renewal = 'extended'
        result.currentPeriodEnd = sub.currentPeriodEnd
      }

      // Asignar plan en backend-roles
      await this.assignPlanInRoles(req.brandId, req.planSlug, sub.currentPeriodEnd)
    }

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
    this.eventBus.notifyPaymentSuccess(
      req.brandId,
      payment.id,
      String(subtotal + taxAmount),
      currency,
    )

    if (req.idempotencyKey) {
      payment.metadata = {
        ...(payment.metadata || {}),
        checkoutResult: result,
      }
      await this.paymentRepo.save(payment)
    }

    this.log.log(
      `Checkout completado: payment=${payment.id} brand=${req.brandId} plan=${req.planSlug}`,
    )
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
        metadata: { paymentId: payment.id, buyer: req.buyer },
      })

      const result: CheckoutResult = {
        paymentId: payment.id,
        status: 'pending',
        checkoutUrl: checkout.checkoutUrl,
      }

      // Actualizar pago con datos del provider
      payment.providerPaymentId = checkout.providerPaymentId
      payment.checkoutUrl = checkout.checkoutUrl
      payment.expiresAt = new Date(
        Date.now() + parseInt(process.env.CHECKOUT_EXPIRY_HOURS || '24') * 3600000,
      )
      if (req.idempotencyKey) {
        payment.metadata = {
          ...(payment.metadata || {}),
          checkoutResult: result,
        }
      }
      await this.paymentRepo.save(payment)

      // Registrar intento
      await this.attemptRepo.save(
        this.attemptRepo.create({
          paymentId: payment.id,
          attemptNumber: 1,
          provider: req.provider,
          status: AttemptStatus.SUCCESS,
          amount: totalAmount,
          attemptedAt: new Date(),
          metadata: { providerPaymentId: checkout.providerPaymentId },
        }),
      )

      this.log.log(`Checkout externo creado: payment=${payment.id} provider=${req.provider}`)

      return result
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
    if (this.inFlightCompletions.has(paymentId)) return
    this.inFlightCompletions.add(paymentId)
    try {
      const payment = await this.paymentRepo.findOne({ where: { id: paymentId } })
      if (
        !payment ||
        payment.status === PaymentStatus.COMPLETED ||
        this.hasAmountMismatchMark(payment)
      ) {
        return
      }

      const metadata = providerData ? { ...payment.metadata, providerData } : payment.metadata
      const claimed = await this.paymentRepo.update(
        { id: paymentId, status: payment.status },
        {
          status: PaymentStatus.PROCESSING,
          ...(providerData ? { metadata } : {}),
        },
      )
      if (!claimed.affected) return

      await this.finalizeProcessingPayment(payment, paymentId, providerData, metadata)
    } finally {
      this.inFlightCompletions.delete(paymentId)
    }
  }

  private async finalizeProcessingPayment(
    payment: Payment,
    paymentId: string,
    providerData?: any,
    metadata?: any,
  ): Promise<void> {
    payment.status = PaymentStatus.PROCESSING
    if (providerData) {
      payment.metadata = metadata
    }

    const totalAmount = parseFloat(String(payment.amount))
    await this.assertProviderConfirmedAmount(payment, totalAmount, providerData)

    // Calcular impuestos para factura. El país sale del pago —lo decidió el checkout con
    // el mismo criterio que el precio—, y el perfil de facturación queda de respaldo para
    // los pagos anteriores a este cambio, que no lo llevan.
    const country = payment.metadata?.country || (await this.getBillingCountry(payment.brandId))
    const isWalletRecharge = payment.purpose === PaymentPurpose.WALLET_RECHARGE
    const hasSavedTaxRate =
      payment.metadata &&
      payment.metadata.taxRate !== undefined &&
      payment.metadata.taxRate !== null &&
      Number.isFinite(Number(payment.metadata.taxRate)) &&
      Number(payment.metadata.taxRate) >= 0

    let tax: { taxName: string; taxRate: number; isInclusive: boolean }
    if (isWalletRecharge && hasSavedTaxRate) {
      tax = this.validateRechargeTaxConfig(country, {
        taxName: String(payment.metadata.taxName || ''),
        taxRate: Number(payment.metadata.taxRate),
        isInclusive: true,
      })
    } else if (isWalletRecharge) {
      tax = await this.resolveRechargeTax(country)
    } else if (hasSavedTaxRate) {
      tax = {
        taxName: String(payment.metadata.taxName || 'N/A'),
        taxRate: Number(payment.metadata.taxRate),
        isInclusive: true,
      }
    } else {
      tax = await this.taxService.getTaxForCountry(country)
    }

    const { subtotal, taxAmount } = this.breakDownTaxInclusiveAmount(totalAmount, tax.taxRate)

    let extendedUntil: Date | undefined

    // Si es compra de plan → crear/renovar suscripción
    if (payment.purpose === PaymentPurpose.PLAN_PURCHASE && payment.purposeId) {
      const { subscription, extended } = await this.createOrRenewSubscription(
        {
          brandId: payment.brandId,
          userId: payment.userId,
          provider: payment.provider as any,
          purpose: 'plan_purchase',
          planSlug: payment.purposeId,
          walletId: payment.walletId,
        },
        payment,
      )
      if (extended && subscription?.currentPeriodEnd) {
        extendedUntil = subscription.currentPeriodEnd
      }
      await this.assignPlanInRoles(
        payment.brandId,
        subscription?.planSlug || payment.purposeId,
        subscription?.currentPeriodEnd,
      )
    }

    if (isWalletRecharge && payment.walletId) {
      const creditResult = await this.walletService.credit(payment.walletId, totalAmount, {
        brandId: payment.brandId,
        category: 'recharge',
        description: `Recarga via ${payment.provider}`,
        referenceType: 'payment',
        referenceId: payment.id,
        idempotencyKey: `payment:${payment.id}:credit`,
      })
      if (
        creditResult &&
        typeof creditResult === 'object' &&
        'error' in creditResult &&
        (creditResult as any).error
      ) {
        throw new Error((creditResult as any).error)
      }
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
        buyer: payment.metadata?.buyer,
      },
      subtotal,
      taxAmount,
      payment.currency,
      tax,
      extendedUntil,
    )

    const paidAt = new Date()
    const completed = await this.paymentRepo.update(
      { id: paymentId, status: PaymentStatus.PROCESSING },
      {
        status: PaymentStatus.COMPLETED,
        paidAt,
      },
    )
    if (!completed.affected) return

    payment.status = PaymentStatus.COMPLETED
    payment.paidAt = paidAt

    this.sendToDianAsync(invoice.id, payment.currency)

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
    this.eventBus.notifyPaymentSuccess(
      payment.brandId,
      payment.id,
      String(payment.amount),
      payment.currency,
    )
    if (invoice) {
      this.eventBus.notifyInvoiceReady(payment.brandId, invoice.id, invoice.invoiceNumber)
    }

    this.log.log(`Pago externo completado: payment=${payment.id} brand=${payment.brandId}`)
  }

  /**
   * Reconciliar un pago consultando el estado REAL en el proveedor.
   *
   * Lo usa la página de retorno (al volver del checkout) y el cron de barrido:
   * si el proveedor confirma el pago, lo completa (idempotente con el webhook).
   * No depende de que el webhook llegue — robusto en cualquier ambiente.
   */
  async reconcilePayment(paymentId: string): Promise<{ status: string; planSlug?: string }> {
    const payment = await this.paymentRepo.findOne({ where: { id: paymentId } })
    if (!payment) {
      throw new RequestException({ code: 'PAYMENT_NOT_FOUND', message: 'Pago no encontrado' }, 404)
    }

    if (payment.status === PaymentStatus.COMPLETED) {
      return { status: 'completed', planSlug: payment.purposeId || undefined }
    }
    if (payment.status === PaymentStatus.FAILED || this.hasAmountMismatchMark(payment)) {
      return { status: 'failed' }
    }
    if (!payment.providerPaymentId) {
      if (payment.status === PaymentStatus.PROCESSING) {
        try {
          await this.completeExternalPayment(paymentId, { source: 'reconcile' })
          const afterReconcile = await this.paymentRepo.findOne({ where: { id: paymentId } })
          if (
            afterReconcile &&
            (afterReconcile.status === PaymentStatus.FAILED ||
              this.hasAmountMismatchMark(afterReconcile))
          ) {
            return { status: 'failed' }
          }
          return { status: 'completed', planSlug: payment.purposeId || undefined }
        } catch (error) {
          this.log.warn(
            `reconcilePayment: error completing processing payment ${paymentId}: ${error.message}`,
          )
          const current = await this.paymentRepo.findOne({ where: { id: paymentId } })
          return { status: current?.status ?? payment.status }
        }
      }
      return { status: payment.status }
    }

    try {
      const provider = this.providerFactory.getProvider(payment.provider)
      const real = await provider.getPaymentStatus(payment.providerPaymentId)

      if (real.status === 'completed') {
        await this.completeExternalPayment(paymentId, {
          source: 'reconcile',
          providerStatus: real.metadata,
        })
        const afterReconcile = await this.paymentRepo.findOne({ where: { id: paymentId } })
        if (
          afterReconcile &&
          (afterReconcile.status === PaymentStatus.FAILED ||
            this.hasAmountMismatchMark(afterReconcile))
        ) {
          return { status: 'failed' }
        }
        return { status: 'completed', planSlug: payment.purposeId || undefined }
      }

      return { status: real.status }
    } catch (error) {
      this.log.warn(
        `reconcilePayment: error consultando ${payment.provider} para ${paymentId}: ${error.message}`,
      )
      const current = await this.paymentRepo.findOne({ where: { id: paymentId } })
      return { status: current?.status ?? payment.status }
    }
  }

  // =============================================================
  // Helpers
  // =============================================================

  /**
   * Resolver monto y moneda según el tipo de checkout.
   */
  private async resolveAmountAndCurrency(req: CheckoutRequest): Promise<ResolvedPricing> {
    // El `planSlug` es parte del CONTRATO de `plan_purchase`, no un opcional: la rama
    // NO se gatea con `&& req.planSlug`. Cuando lo hacía, una compra de plan sin slug
    // caía a la rama genérica de abajo y cobraba el `amount`/`currency` que eligió el
    // llamador, con `purposeId=null`, la wallet debitada y una factura "Plan undefined";
    // el precio por país nunca se consultaba. Ahora entra siempre y la guarda decide.
    //
    // Se reusa el 400 `INVALID_PLAN_SLUG` en vez de crear un `MISSING_PLAN_SLUG`: es la
    // simetría exacta de `INVALID_BRAND_ID`, que ya cubre "ausente o que no es un UUID",
    // y no obliga a ningún cliente a aprender un código nuevo para el mismo rechazo.
    //
    // Vale también para `renewal: true`: la indulgencia del cron (`renewalPlanPrice`)
    // está acotada por diseño a los CÓDIGOS de resolución de país/precio, no al
    // contrato —sin slug no hay precio legacy que resolver—. Ese caso ya moría antes,
    // sólo que con `MISSING_AMOUNT`; para `TasksService` el desenlace observable sigue
    // siendo excepción → `past_due`, ahora con un código que dice la verdad.
    if (req.purpose === 'plan_purchase') {
      this.assertUsablePlanSlug(req.planSlug)

      // Moneda pedida por el llamador. Sobrevive SÓLO para el precio negociado
      // enterprise y para el fallback de la renovación: el alta no la mira.
      const legacyCurrency = req.currency || 'COP'

      // Para plan enterprise, verificar si hay precio personalizado
      if (req.planSlug === 'enterprise') {
        const customPricing = await this.enterprisePricing.getForBrand(req.brandId)
        if (customPricing) {
          // Alta: la moneda del precio negociado es un dato DERIVADO de la fila, igual
          // que en el catálogo por país. Compararla contra `req.currency` dejaba que el
          // llamador se saliera de lo negociado mandando otra moneda: hoy eso cae al
          // catálogo por país —que siempre tiene fila— y cobra el precio de lista.
          if (!req.renewal) {
            return { amount: Number(customPricing.monthlyPrice), currency: customPricing.currency }
          }
          // Renovación: la comparación legacy queda intacta.
          if (customPricing.currency === legacyCurrency) {
            return { amount: Number(customPricing.monthlyPrice), currency: legacyCurrency }
          }
        }
      }

      // Renovación del cron: INDULGENTE (criterio (e)). Intenta el mismo catálogo
      // por país que el alta y sólo cae al precio legacy si no puede resolverlo.
      if (req.renewal) {
        return this.renewalPlanPrice(req, legacyCurrency)
      }

      // Alta: el precio sale del país de la marca, no de lo que mande el cliente.
      const resolved = await this.resolvePlanPricingByCountry(req.brandId, req.planSlug)
      if (!resolved.ok) {
        // El servicio no tiene ExceptionFilter global, así que una `HttpException`
        // lanzada acá no deja rastro: sin este log, un alta rechazada por
        // PRICE_NOT_FOUND_FOR_COUNTRY o PLAN_NOT_FOUND (el síntoma de un outage de
        // backend-roles) es invisible en los logs del servicio.
        this.log.warn(
          `Alta rechazada: brand=${req.brandId} plan=${req.planSlug} ` +
            `country=${resolved.country || 'desconocido'} code=${resolved.code}`,
        )
        throw this.planPricingException(req.planSlug, resolved.code)
      }

      return { amount: resolved.amount, currency: resolved.currency, country: resolved.country }
    }

    if (!req.currency) {
      throw new RequestException({ code: 'MISSING_AMOUNT', message: 'Monto y moneda requeridos' })
    }

    if (typeof req.amount !== 'number' || !Number.isFinite(req.amount) || req.amount <= 0) {
      throw new RequestException(
        { code: 'INVALID_AMOUNT', message: 'Amount must be a finite number greater than zero' },
        HttpStatus.BAD_REQUEST,
      )
    }

    return { amount: req.amount, currency: req.currency }
  }

  /**
   * Precio del plan por el camino LEGACY (moneda pedida por el llamador).
   * Conserva tal cual el comportamiento anterior; hoy sólo lo usa la renovación.
   */
  private async legacyPlanPrice(planSlug: string, currency: string): Promise<ResolvedPricing> {
    const price = await this.clientRoles.getPlanPrice(planSlug, currency)
    if (price === null) {
      throw new RequestException({
        code: 'INVALID_PLAN',
        message: `Plan '${planSlug}' no disponible en moneda '${currency}'`,
      })
    }
    return { amount: price, currency }
  }

  /**
   * Precio de la RENOVACIÓN emitida por el cron. Indulgente por diseño, al revés
   * que el alta: intenta el mismo catálogo por país y sólo cae al precio legacy
   * cuando no puede resolverlo, dejando un `logger.error` con marca, país y código.
   *
   * Por qué indulgente y no estricto: un rechazo acá no es un 4xx para nadie.
   * `TasksService.issueExternalCharge` atrapa la excepción, marca la suscripción
   * `past_due` SIN link de pago y tras `MAX_RETRY` la marca se degrada a free — o
   * sea que cualquier severidad de más en este camino se cobra en ingresos
   * perdidos, en silencio y sobre suscripciones que hoy se cobran bien.
   *
   * Por el mismo motivo el `brandId` NO se valida como UUID: `subscriptions.brandId`
   * es un `varchar` sin FK ni tipo `uuid` (`subscription.entity.ts`) y la convención
   * del monorepo es que los ids cross-service son strings. Una suscripción viva con
   * un id no canónico se sigue cobrando exactamente como hasta hoy.
   *
   * La leniencia está acotada a los CÓDIGOS de resolución de país/precio: los dos
   * colaboradores devuelven resultado discriminado y no lanzan, así que no hay
   * `catch` que pueda tragarse un error de otra naturaleza.
   */
  private async renewalPlanPrice(
    req: CheckoutRequest,
    legacyCurrency: string,
  ): Promise<ResolvedPricing> {
    if (this.isUsableBrandId(req.brandId)) {
      const resolved = await this.resolvePlanPricingByCountry(req.brandId.trim(), req.planSlug)
      if (resolved.ok) {
        return { amount: resolved.amount, currency: resolved.currency, country: resolved.country }
      }
      this.log.error(
        `Renovación fuera del catálogo por país: brand=${req.brandId} plan=${req.planSlug} ` +
          `country=${resolved.country || 'desconocido'} code=${resolved.code} → precio legacy ${legacyCurrency}`,
      )
    } else {
      this.log.error(
        `Renovación con brandId no consultable: brand=${req.brandId} plan=${req.planSlug} ` +
          `→ precio legacy ${legacyCurrency}`,
      )
    }

    return this.legacyPlanPrice(req.planSlug, legacyCurrency)
  }

  /**
   * Precio del plan resuelto por el país registrado de la marca. La moneda es un
   * dato DERIVADO de la fila de precio, no un parámetro del llamador.
   *
   * Se usa `resolveBrandCountry` y no el envoltorio `getBrandCountry` porque éste
   * colapsa los tres modos de fallo en `null`, y acá cada uno mapea a un HTTP
   * distinto: este camino es exactamente el consumidor para el que se crearon
   * esos códigos.
   *
   * La fila devuelta por `resolvePriceForCountry` es la instancia CACHEADA de
   * `ClientRolesService`: se lee, nunca se muta.
   */
  private async resolvePlanPricingByCountry(
    brandId: string,
    planSlug: string,
  ): Promise<
    // Los `?: never` de la rama contraria replican el molde de
    // `PriceResolution`/`BrandCountryResolution`: con `strictNullChecks: false`
    // TypeScript no estrecha la unión por un discriminante booleano sin ellos.
    | { ok: true; amount: number; currency: string; country: string; code?: never }
    | {
        ok: false
        code: BrandCountryErrorCode | PriceResolutionErrorCode
        country?: string
        amount?: never
        currency?: never
      }
  > {
    const brand = await this.clientPlatform.resolveBrandCountry(brandId)
    if (!brand.ok) return { ok: false, code: brand.code }

    const price = await this.clientRoles.resolvePriceForCountry(planSlug, brand.country)
    if (!price.ok) return { ok: false, code: price.code, country: brand.country }

    // La fila viene de un JSON de backend-roles: `Number(price)` da `NaN` con un
    // decimal malformado y **0 con `price: null`**, y la moneda se persiste verbatim
    // en `payment.currency`. Cobrar `NaN` o regalar un plan pago porque a la fila le
    // falta el precio es peor que rechazar el alta. El 0 SÍ es un precio válido —el
    // plan `free` tiene filas de 0.00, medido en dev el 2026-08-25—, así que se
    // rechaza la AUSENCIA de precio, no el valor cero.
    const raw = price.price.price
    const amount = Number(raw)
    const currency = String(price.price.currency || '').toUpperCase()
    const missing = raw === null || raw === undefined
    if (missing || !Number.isFinite(amount) || amount < 0 || !/^[A-Z]{3}$/.test(currency)) {
      this.log.error(
        `Fila de precio inválida para plan=${planSlug} country=${brand.country}: ` +
          `price=${String(raw)} currency=${String(price.price.currency)}`,
      )
      return { ok: false, code: PRICE_NOT_FOUND_FOR_COUNTRY, country: brand.country }
    }

    return { ok: true, amount, currency, country: brand.country }
  }

  /**
   * Copia de la request con el `brandId` ya normalizado, para que el mismo valor
   * alimente el gate de proveedor, `enterprise_pricing`, platform, el pago, la
   * suscripción y la asignación de plan. Se devuelve una copia en vez de reescribir
   * `req.brandId`: la mutación escondía un efecto load-bearing y le reescribía el
   * objeto al cron, que arma la request desde una fila viva de `subscriptions`.
   *
   * El UUID se EXIGE sólo en el alta de plan. La renovación se limita a recortar
   * espacios (ver `renewalPlanPrice`: un id no canónico de una suscripción viva no
   * puede convertirse en un cobro fallido), y los demás `purpose` conservan el
   * comportamiento de hoy — endurecerlos es otra tarea, con sus propios clientes.
   */
  private normalizeRequest(req: CheckoutRequest): CheckoutRequest {
    const brandId =
      req.purpose === 'plan_purchase' && !req.renewal
        ? this.assertUsableBrandId(req.brandId)
        : typeof req.brandId === 'string'
          ? req.brandId.trim()
          : req.brandId

    if (req.idempotencyKey === undefined) {
      return { ...req, brandId }
    }

    const idempotencyKey =
      typeof req.idempotencyKey === 'string' && req.idempotencyKey.trim().length > 0
        ? req.idempotencyKey.trim()
        : undefined

    return { ...req, brandId, idempotencyKey }
  }

  /** UUID canónico: el formato con el que platform indexa `brand.id`. */
  private static readonly BRAND_ID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  /** ¿Este brandId se puede consultar en platform sin provocar un 400? */
  private isUsableBrandId(brandId: string): boolean {
    return typeof brandId === 'string' && CheckoutService.BRAND_ID_RE.test(brandId.trim())
  }

  /**
   * `CheckoutRequest` es una interfaz y `@Body() body: CheckoutRequest` no tiene DTO
   * ni validador, así que un brandId basura llega crudo hasta platform: ahí responde
   * 400 (`ParseUUIDPipe`) o 404 (`AuthMiddleware`) y `ClientPlatformService` clasifica
   * ambos como el transitorio `BRAND_LOOKUP_UNAVAILABLE` → 503 por un error del
   * llamador. Esta guarda hace cierta la suposición que dejó anotada esa dependencia
   * ("en payments el brandId viene de un DTO ya validado").
   *
   * Devuelve el id NORMALIZADO: validar sobre el `trim()` y seguir usando el valor
   * crudo dejaba pasar un `' <uuid> '` que platform rechaza con 400 → el mismo 503
   * engañoso que esta guarda existe para evitar, y que además se persistía con
   * espacios en `payment.brandId`.
   */
  private assertUsableBrandId(brandId: string): string {
    const normalized = typeof brandId === 'string' ? brandId.trim() : ''
    if (!this.isUsableBrandId(normalized)) {
      throw new RequestException(
        { code: 'INVALID_BRAND_ID', message: 'brandId requerido y debe ser un UUID' },
        HttpStatus.BAD_REQUEST,
      )
    }
    return normalized
  }

  /**
   * El `planSlug` es texto libre del llamador —misma razón que el brandId: no hay
   * DTO— y termina en dos lugares peligrosos: los logs y la URL de backend-roles.
   * Un slug con `\n` inyecta líneas falsas en el log (CWE-117) y uno con `/` o `?`
   * reescribe la ruta de `assignPlanToBrand`. El catálogo real usa `a-z`, `0-9`,
   * `-` y `_` (`dropi-roax`, `ally_dropi_pro`), así que la clase es holgada.
   *
   * El `typeof` es LOAD-BEARING, no ruido defensivo: `regex.test(undefined)` coacciona
   * el argumento a la cadena `"undefined"`, que MATCHEA la clase y pasaría la guarda.
   * Sin él, exigir el slug en la rama de plan no cerraría la ausencia —justo el caso
   * que esta guarda tiene que rechazar—. El valor crudo no se loguea ni se devuelve:
   * es texto libre del llamador (CWE-117), la misma razón por la que existe la clase.
   */
  private assertUsablePlanSlug(planSlug: string) {
    if (typeof planSlug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(planSlug)) {
      throw new RequestException(
        { code: 'INVALID_PLAN_SLUG', message: 'planSlug inválido' },
        HttpStatus.BAD_REQUEST,
      )
    }
  }

  /**
   * Validates that the wallet referenced by `req` can settle a checkout in `currency`
   * before a `Payment` record is persisted.
   *
   * Rejects missing `req.walletId` (`MISSING_WALLET_ID`, 400) so `findById` is never
   * called with `undefined`, rejects wallets owned by another brand with the generic
   * `WALLET_NOT_FOUND` (404) response to avoid an existence oracle, and rejects
   * `TKN` wallets or currency mismatches with `WALLET_CURRENCY_MISMATCH` (422).
   * `WalletService.debit` re-enforces these invariants under the `pessimistic_write`
   * row lock during the debit transaction.
   *
   * @param req Checkout request containing `brandId` and `walletId`.
   * @param currency Resolved ISO currency code for the checkout charge.
   */
  private async assertWalletCurrency(req: CheckoutRequest, currency: string) {
    if (typeof req.walletId !== 'string' || !req.walletId.trim()) {
      throw new RequestException(
        { code: 'MISSING_WALLET_ID', message: 'walletId requerido para pagar con la wallet' },
        HttpStatus.BAD_REQUEST,
      )
    }

    const found = await this.walletService.findById(req.walletId)
    const wallet: Wallet = found && 'data' in found ? found.data : null
    if (!wallet) return

    if (wallet.brandId !== req.brandId) {
      throw new RequestException(
        { code: 'WALLET_NOT_FOUND', message: 'Wallet no encontrada' },
        HttpStatus.NOT_FOUND,
      )
    }

    if (
      wallet.currency?.toUpperCase() === 'TKN' ||
      currency?.toUpperCase() === 'TKN' ||
      wallet.currency !== currency
    ) {
      throw new RequestException(
        {
          code: 'WALLET_CURRENCY_MISMATCH',
          message:
            wallet.currency?.toUpperCase() === 'TKN' || currency?.toUpperCase() === 'TKN'
              ? 'Token wallets (TKN) cannot be used in checkout'
              : `La wallet está en ${wallet.currency} y el cobro es en ${currency}`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
  }

  /**
   * Mapea el fallo de resolución de país/precio a su HTTP.
   *
   * `PLAN_NOT_FOUND` responde 503 y NO 404 a propósito: `getPlanRows()` devuelve un
   * Map VACÍO cuando backend-roles no contesta y no hay caché, así que durante un
   * outage de roles TODOS los planes darían `PLAN_NOT_FOUND`; contestar "ese plan no
   * existe" disfrazaría una caída de backend como un error definitivo del cliente,
   * justo la inversión del criterio transitorio→503 con que se diseñaron los códigos
   * de país. Costo aceptado: un planSlug realmente mal escrito recibe 503 en vez de
   * 400; los slugs vienen de nuestra propia UI y 503 es la dirección segura.
   */
  private planPricingException(
    planSlug: string,
    code: BrandCountryErrorCode | PriceResolutionErrorCode,
  ): RequestException {
    switch (code) {
      case BRAND_LOOKUP_UNAVAILABLE:
        return new RequestException(
          {
            code: BRAND_LOOKUP_UNAVAILABLE,
            message: 'No se pudo consultar el país de la marca, reintentá en unos minutos',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
      case BRAND_NOT_FOUND:
        return new RequestException(
          { code: BRAND_NOT_FOUND, message: 'La marca no existe' },
          HttpStatus.NOT_FOUND,
        )
      case BRAND_WITHOUT_COUNTRY:
        return new RequestException(
          {
            code: BRAND_WITHOUT_COUNTRY,
            message: 'La marca no tiene país registrado: no se puede determinar el precio',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      case PRICE_NOT_FOUND_FOR_COUNTRY:
        // El país NO va en el mensaje: el endpoint contesta sin autenticar, así que
        // devolverlo convierte al checkout en un lector del país de cualquier marca.
        // Queda en el `logger.warn` del punto de rechazo, que es quien lo necesita.
        return new RequestException(
          {
            code: PRICE_NOT_FOUND_FOR_COUNTRY,
            message: `El plan '${planSlug}' no tiene precio para el país de la marca`,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      case PLAN_NOT_FOUND:
      default:
        return new RequestException(
          { code: PLAN_NOT_FOUND, message: `Catálogo de planes no disponible para '${planSlug}'` },
          HttpStatus.SERVICE_UNAVAILABLE,
        )
    }
  }

  /**
   * Crear o renovar suscripción.
   */
  private async createOrRenewSubscription(
    req: CheckoutRequest,
    payment: Payment,
  ): Promise<{ subscription: Subscription; extended: boolean }> {
    const now = new Date()
    const periodEnd = new Date()
    periodEnd.setDate(periodEnd.getDate() + this.BILLING_PERIOD_DAYS)

    // Buscar suscripción existente
    let subscription = await this.subscriptionRepo.findOne({
      where: { brandId: req.brandId },
    })

    if (subscription) {
      if (payment?.id) {
        const existingEvent = await this.subscriptionEventRepo.findOne({
          where: { paymentId: payment.id },
        })
        if (subscription.lastPaymentId === payment.id || existingEvent) {
          return {
            subscription,
            extended: existingEvent?.metadata?.renewal === 'extended',
          }
        }
      }
      // Renovar/cambiar plan
      const fromPlan = subscription.planSlug
      const fromStatus = subscription.status
      const existingPeriodEnd =
        subscription.currentPeriodEnd instanceof Date
          ? subscription.currentPeriodEnd
          : subscription.currentPeriodEnd
            ? new Date(subscription.currentPeriodEnd)
            : null
      const isSameActivePlanExtension =
        fromStatus === SubscriptionStatus.ACTIVE &&
        !subscription.cancelledAt &&
        fromPlan === req.planSlug &&
        existingPeriodEnd !== null &&
        !Number.isNaN(existingPeriodEnd.getTime()) &&
        existingPeriodEnd.getTime() > now.getTime()

      const targetPeriodEnd = isSameActivePlanExtension
        ? new Date(existingPeriodEnd.getTime())
        : periodEnd
      if (isSameActivePlanExtension) {
        targetPeriodEnd.setDate(targetPeriodEnd.getDate() + this.BILLING_PERIOD_DAYS)
      }

      subscription.planSlug = req.planSlug
      subscription.status = SubscriptionStatus.ACTIVE
      subscription.provider = req.provider as SubscriptionProvider
      subscription.walletId = req.walletId || subscription.walletId
      subscription.currentPeriodStart = isSameActivePlanExtension
        ? subscription.currentPeriodStart || now
        : now
      subscription.currentPeriodEnd = targetPeriodEnd
      subscription.nextBillingDate = targetPeriodEnd
      subscription.lastPaymentId = payment.id
      subscription.retryCount = 0
      subscription.cancelledAt = null
      subscription.cancelReason = null
      // Invariante de `accessEndsAt`: no nula ⇔ hay una baja PENDIENTE. La marca que
      // canceló y después pagó ya no la tiene, y dejarle la fecha de corte vieja la
      // mostraría en `GET /subscription/current` sobre una suscripción que se renueva.
      subscription.accessEndsAt = null
      subscription.autoRenew = true

      await this.subscriptionRepo.save(subscription)

      // Registrar evento
      const eventType =
        fromPlan !== req.planSlug
          ? SubscriptionEventType.PLAN_CHANGED
          : SubscriptionEventType.RENEWED

      await this.subscriptionEventRepo.save(
        this.subscriptionEventRepo.create({
          subscriptionId: subscription.id,
          eventType,
          fromPlanSlug: fromPlan,
          toPlanSlug: req.planSlug,
          fromStatus,
          toStatus: SubscriptionStatus.ACTIVE,
          triggeredBy: req.userId,
          paymentId: payment.id,
          reason:
            eventType === SubscriptionEventType.PLAN_CHANGED
              ? `Cambio de plan ${fromPlan} → ${req.planSlug}`
              : 'Renovación por pago',
          ...(isSameActivePlanExtension
            ? {
                metadata: {
                  renewal: 'extended',
                  currentPeriodEnd: targetPeriodEnd.toISOString(),
                },
              }
            : {}),
        }),
      )

      return { subscription, extended: isSameActivePlanExtension }
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

      await this.subscriptionEventRepo.save(
        this.subscriptionEventRepo.create({
          subscriptionId: subscription.id,
          eventType: SubscriptionEventType.CREATED,
          toPlanSlug: req.planSlug,
          toStatus: SubscriptionStatus.ACTIVE,
          triggeredBy: req.userId,
          paymentId: payment.id,
        }),
      )
    }

    return { subscription, extended: false }
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
    extendedUntil?: Date,
  ): Promise<any> {
    const billingProfile = await this.billingProfileRepo.findOne({
      where: { brandId: payment.brandId },
    })

    const suffix = payment?.id
      ? `-${String(payment.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`
      : ''
    const invoiceNumber = `${process.env.INVOICE_PREFIX || 'CK'}-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}${suffix}`

    const invoiceTotal = Math.round((subtotal + taxAmount) * 100) / 100
    const items = []

    if (req.purpose === 'plan_purchase') {
      const description = extendedUntil
        ? `Extensión del plan ${req.planSlug} hasta ${extendedUntil.toISOString()}`
        : `Plan ${req.planSlug} — Suscripción mensual Cubiko`
      items.push({
        description,
        quantity: 1,
        unitPrice: subtotal,
        subtotal,
        taxRate: tax.taxRate ?? 0,
        taxAmount,
        total: invoiceTotal,
        productType: 'plan',
        referenceType: 'subscription',
        referenceId: req.planSlug,
      })
    } else if (req.purpose === 'wallet_recharge') {
      items.push({
        description: 'Créditos de uso de la plataforma ROAX',
        quantity: 1,
        unitPrice: subtotal,
        subtotal,
        taxRate: tax.taxRate ?? 0,
        taxAmount,
        total: invoiceTotal,
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
        taxRate: tax.taxRate ?? 0,
        taxAmount,
        total: invoiceTotal,
        productType: 'service',
        referenceType: 'payment',
        referenceId: payment.id,
      })
    }

    const requestBuyer = req?.buyer || payment.metadata?.buyer
    const buyerIdentification = {
      brandId: payment.brandId,
      userId: payment.userId,
      ...(billingProfile
        ? {
            billingProfileId: billingProfile.id,
            legalName: billingProfile.legalName,
            taxId: billingProfile.taxId,
            taxIdType: billingProfile.taxIdType,
            email: billingProfile.email,
            country: billingProfile.country,
          }
        : {}),
      ...(requestBuyer
        ? {
            firstName: requestBuyer.firstName,
            lastName: requestBuyer.lastName,
            name:
              [requestBuyer.firstName, requestBuyer.lastName].filter(Boolean).join(' ') ||
              billingProfile?.legalName ||
              undefined,
            email: requestBuyer.email || billingProfile?.email,
            phoneNumber: requestBuyer.phoneNumber || billingProfile?.phone,
          }
        : {}),
    }

    const result = await this.invoiceService.create({
      brandId: payment.brandId,
      paymentId: payment.id,
      billingProfileId: billingProfile?.id || null,
      invoiceNumber,
      subtotal,
      taxTotal: taxAmount,
      total: invoiceTotal,
      currency,
      status: InvoiceStatus.PAID,
      issuedAt: new Date(),
      paidAt: new Date(),
      ...(req.purpose === 'wallet_recharge'
        ? {
            metadata: {
              serviceDescription: 'Créditos de uso de la plataforma ROAX',
              taxRate: tax.taxRate ?? 0,
              taxName: tax.taxName || 'N/A',
              buyer: buyerIdentification,
            },
          }
        : {}),
      items,
    })

    if (result && typeof result === 'object' && 'error' in result && (result as any).error) {
      throw new Error((result as any).error)
    }
    if (!result?.data) {
      throw new Error('Failed to create invoice')
    }

    return result.data
  }

  private async resolveRechargeTax(
    taxCountry: string,
  ): Promise<{ taxName: string; taxRate: number; isInclusive: boolean }> {
    const normalizedCountry = String(taxCountry || '')
      .trim()
      .toUpperCase()
    let tax: { taxName: string; taxRate: number; isInclusive: boolean } | null = null
    try {
      tax = await this.taxService.getTaxForCountry(taxCountry)
    } catch (error) {
      this.log.error(
        `Unable to read tax rate for country ${normalizedCountry || taxCountry}: ${error.message}`,
      )
      throw new RequestException(
        {
          code: 'TAX_RATE_UNAVAILABLE',
          message: `Unable to read tax rate for country ${normalizedCountry || taxCountry}`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    return this.validateRechargeTaxConfig(taxCountry, tax)
  }

  private validateRechargeTaxConfig(
    taxCountry: string,
    tax: { taxName: string; taxRate: number; isInclusive: boolean } | null | undefined,
  ): { taxName: string; taxRate: number; isInclusive: boolean } {
    const normalizedCountry = String(taxCountry || '')
      .trim()
      .toUpperCase()
    const parsedRate =
      tax && tax.taxRate !== null && tax.taxRate !== undefined ? Number(tax.taxRate) : NaN
    const normalizedTaxName = String(tax?.taxName || '').trim()
    const requiresVat = isVatCountry(normalizedCountry) || normalizedTaxName.toUpperCase() === 'IVA'
    const isUnreadable =
      !tax ||
      !Number.isFinite(parsedRate) ||
      parsedRate < 0 ||
      (requiresVat && (normalizedTaxName === 'N/A' || parsedRate <= 0))

    if (isUnreadable) {
      this.log.error(
        `Unable to read a valid tax rate for country ${normalizedCountry || taxCountry}`,
      )
      throw new RequestException(
        {
          code: 'TAX_RATE_UNAVAILABLE',
          message: `Unable to read a valid tax rate for country ${normalizedCountry || taxCountry}`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    return {
      taxName: normalizedTaxName || 'N/A',
      taxRate: parsedRate,
      isInclusive: true,
    }
  }

  /**
   * Shared tax breakdown rule for `processCheckout` and `completeExternalPayment`:
   * all published prices are final tax-inclusive amounts and ignore `tax_config.isInclusive`,
   * extracting `subtotal = round(total / (1 + rate))` and `taxAmount = round(total - subtotal)`.
   */
  private breakDownTaxInclusiveAmount(
    totalAmount: number,
    taxRate: number,
  ): { subtotal: number; taxAmount: number; totalAmount: number } {
    const normalizedTotal = Math.round(Number(totalAmount) * 100) / 100
    const normalizedRate = Number(taxRate)
    if (!Number.isFinite(normalizedRate) || normalizedRate <= 0) {
      return {
        subtotal: normalizedTotal,
        taxAmount: 0,
        totalAmount: normalizedTotal,
      }
    }
    const subtotal = Math.round((normalizedTotal / (1 + normalizedRate)) * 100) / 100
    const taxAmount = Math.round((normalizedTotal - subtotal) * 100) / 100
    return {
      subtotal,
      taxAmount,
      totalAmount: normalizedTotal,
    }
  }

  private readonly providerConfirmedAmountSpecs: Record<
    string,
    | {
        verifiesAmount: false
        reason: 'provider_webhook_omits_confirmed_amount'
      }
    | {
        verifiesAmount: true
        unit: 'cents' | 'major'
        extractConfirmedAmount: (providerData: any) => unknown
      }
  > = {
    [PaymentProvider.STRIPE]: {
      verifiesAmount: true,
      unit: 'cents',
      extractConfirmedAmount: (providerData: any) =>
        providerData?.amount ??
        providerData?.amount_total ??
        providerData?.amountTotal ??
        providerData?.data?.object?.amount ??
        providerData?.data?.object?.amount_total ??
        providerData?.providerStatus?.amountTotal,
    },
    [PaymentProvider.CONFIO]: {
      verifiesAmount: true,
      unit: 'cents',
      extractConfirmedAmount: (providerData: any) =>
        providerData?.data?.amountCents ??
        providerData?.amountCents ??
        providerData?.providerStatus?.amountCents,
    },
    [PaymentProvider.DROPI]: {
      verifiesAmount: true,
      unit: 'major',
      extractConfirmedAmount: (providerData: any) =>
        providerData?.amount ?? providerData?.data?.amount,
    },
    [PaymentProvider.MERCADOPAGO]: {
      verifiesAmount: false,
      reason: 'provider_webhook_omits_confirmed_amount',
    },
  }

  private hasAmountMismatchMark(payment?: Payment | null): boolean {
    return Boolean(payment?.metadata && payment.metadata.amountMismatch)
  }

  private async markPaymentAmountMismatch(
    payment: Payment,
    providerData: any,
    mismatch: {
      code: 'PROVIDER_AMOUNT_MISMATCH'
      paymentId: string
      provider: string
      unit: 'cents' | 'major'
      expectedAmount: number
      confirmedAmount: number
      message: string
    },
  ): Promise<void> {
    const updatedMetadata = {
      ...(payment.metadata || {}),
      ...(providerData ? { providerData } : {}),
      amountMismatch: mismatch,
    }
    await this.paymentRepo.update(
      { id: payment.id, status: payment.status },
      {
        status: PaymentStatus.FAILED,
        failureReason: mismatch.message,
        metadata: updatedMetadata,
      },
    )
  }

  private toConfirmedAmountUnit(amountInMajorUnits: number, unit: 'cents' | 'major'): number {
    if (unit === 'cents') {
      return Math.round(Number(amountInMajorUnits) * 100)
    }
    return Math.round(Number(amountInMajorUnits) * 100) / 100
  }

  private normalizeConfirmedAmountInUnit(rawAmount: number, unit: 'cents' | 'major'): number {
    if (unit === 'cents') {
      return Math.round(rawAmount)
    }
    return Math.round(rawAmount * 100) / 100
  }

  private async assertProviderConfirmedAmount(
    payment: Payment,
    expectedAmount: number,
    providerData?: any,
  ): Promise<void> {
    const providerKey = String(payment.provider || '').toLowerCase()
    const spec = this.providerConfirmedAmountSpecs[providerKey]
    if (!spec || !spec.verifiesAmount) {
      return
    }
    if (!providerData || typeof providerData !== 'object') {
      return
    }
    const rawCandidate = spec.extractConfirmedAmount(providerData)
    if (rawCandidate === undefined || rawCandidate === null || rawCandidate === '') {
      return
    }
    const numericConfirmed = Number(rawCandidate)
    if (!Number.isFinite(numericConfirmed)) {
      return
    }
    const expectedInUnit = this.toConfirmedAmountUnit(expectedAmount, spec.unit)
    const confirmedInUnit = this.normalizeConfirmedAmountInUnit(numericConfirmed, spec.unit)
    if (expectedInUnit !== confirmedInUnit) {
      const message =
        `Provider confirmed gross amount (${confirmedInUnit} ${spec.unit}) does not match ` +
        `payment.amount (${expectedInUnit} ${spec.unit}) for payment ${payment.id}`
      const mismatch = {
        code: 'PROVIDER_AMOUNT_MISMATCH' as const,
        paymentId: payment.id,
        provider: providerKey,
        unit: spec.unit,
        expectedAmount: expectedInUnit,
        confirmedAmount: confirmedInUnit,
        message,
      }
      this.log.error(message)
      winstonLogger.log('error', message, mismatch)
      await this.markPaymentAmountMismatch(payment, providerData, mismatch)
      throw new RequestException(
        {
          code: 'PROVIDER_AMOUNT_MISMATCH',
          paymentId: payment.id,
          message,
        },
        HttpStatus.CONFLICT,
      )
    }
  }

  /**
   * Enviar factura a DIAN en background (no bloquea el checkout).
   */
  private sendToDianAsync(invoiceId: string, currency: string) {
    // La facturación electrónica de este servicio es COLOMBIANA (DIAN/Siigo) y
    // `DianService.sendInvoice` decide el país por el perfil de facturación, que por
    // defecto es 'CO'. Desde que la moneda es un dato derivado del país de la marca,
    // una factura en USD llegaría a la DIAN disfrazada de nacional: se corta acá,
    // que es donde se conoce la moneda del documento.
    if (currency && currency.toUpperCase() !== 'COP') {
      this.log.warn(
        `Factura ${invoiceId} emitida en ${currency}: no se envía a la DIAN ` +
          '(facturación electrónica colombiana)',
      )
      return
    }

    if (!this.dianService.isConfigured()) return

    // Fire and forget — no bloquea el response al usuario
    this.dianService.sendInvoice(invoiceId).catch((error) => {
      winstonLogger.log('error', `Error enviando factura ${invoiceId} a DIAN: ${error.message}`)
    })
  }

  /**
   * Asignar plan a la marca en backend-roles con expiresAt.
   * Calcula expiresAt = currentPeriodEnd de la suscripción (BILLING_PERIOD_DAYS).
   */
  private async assignPlanInRoles(brandId: string, planSlug: string, expiresAt?: Date) {
    let resolvedExpiresAt =
      expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null
    if (!resolvedExpiresAt) {
      resolvedExpiresAt = new Date()
      resolvedExpiresAt.setDate(resolvedExpiresAt.getDate() + this.BILLING_PERIOD_DAYS)
    }
    await this.clientRoles.assignPlanToBrand(brandId, planSlug, resolvedExpiresAt)
  }

  /**
   * País del perfil de FACTURACIÓN de la marca (para impuestos y gate de proveedor).
   * No confundir con `clientPlatform.getBrandCountry`, que es el país registrado de
   * la marca en platform y es el que determina el precio.
   */
  private async getBillingCountry(brandId: string): Promise<string> {
    const profile = await this.billingProfileRepo.findOne({
      where: { brandId },
    })
    return profile?.country || 'CO' // Default Colombia
  }

  private isUniqueConstraintViolation(error: any): boolean {
    return error?.code === '23505' || error?.driverError?.code === '23505'
  }

  private createIdempotencyConflictException(): RequestException {
    return new RequestException(
      {
        code: 'IDEMPOTENCY_KEY_CONFLICT',
        message: 'Idempotency-Key was already used with a different checkout request body',
      },
      HttpStatus.CONFLICT,
    )
  }

  private buildIdempotencyFingerprint(req: CheckoutRequest): string {
    return JSON.stringify({
      userId: req.userId || null,
      purpose: req.purpose || null,
      provider: req.provider || null,
      planSlug: req.planSlug || null,
      amount: req.amount !== undefined && req.amount !== null ? Number(req.amount) : null,
      currency: req.currency ? String(req.currency).toUpperCase() : null,
      walletId: req.walletId || null,
      successUrl: req.successUrl || null,
      cancelUrl: req.cancelUrl || null,
      buyer: req.buyer
        ? {
            firstName: req.buyer.firstName || null,
            lastName: req.buyer.lastName || null,
            email: req.buyer.email || null,
            phoneNumber: req.buyer.phoneNumber || null,
          }
        : null,
      renewal: Boolean(req.renewal),
    })
  }

  private assertMatchingIdempotencyPayload(
    existing: Payment,
    req: CheckoutRequest,
    incomingFingerprint?: string,
  ): void {
    const storedFingerprint = existing.metadata?.idempotencyFingerprint
    if (typeof storedFingerprint === 'string' && incomingFingerprint) {
      if (storedFingerprint !== incomingFingerprint) {
        throw this.createIdempotencyConflictException()
      }
      return
    }

    if (existing.purpose && req.purpose && String(existing.purpose) !== String(req.purpose)) {
      throw this.createIdempotencyConflictException()
    }
    if (existing.provider && req.provider && String(existing.provider) !== String(req.provider)) {
      throw this.createIdempotencyConflictException()
    }
    if ((existing.purposeId || null) !== (req.planSlug || null)) {
      throw this.createIdempotencyConflictException()
    }
    if ((existing.walletId || null) !== (req.walletId || null)) {
      throw this.createIdempotencyConflictException()
    }
    if (
      req.amount !== undefined &&
      existing.amount !== undefined &&
      Number(existing.amount) !== Number(req.amount)
    ) {
      throw this.createIdempotencyConflictException()
    }
    if (
      req.currency !== undefined &&
      existing.currency !== undefined &&
      String(existing.currency).toUpperCase() !== String(req.currency).toUpperCase()
    ) {
      throw this.createIdempotencyConflictException()
    }
  }

  private async resolveExistingIdempotentPayment(
    existing: Payment,
    req: CheckoutRequest,
    incomingFingerprint?: string,
  ): Promise<CheckoutResult> {
    this.assertMatchingIdempotencyPayload(existing, req, incomingFingerprint)

    const inFlightKey = req.idempotencyKey ? `${req.brandId}:${req.idempotencyKey}` : undefined
    if (inFlightKey) {
      const active = this.inFlightCheckouts.get(inFlightKey)
      if (active) {
        if (incomingFingerprint && active.fingerprint !== incomingFingerprint) {
          throw this.createIdempotencyConflictException()
        }
        return active.promise
      }
    }

    if (existing.metadata?.checkoutResult) {
      return existing.metadata.checkoutResult as CheckoutResult
    }

    if (existing.status === PaymentStatus.PENDING && req.idempotencyKey) {
      const refreshed = await this.paymentRepo.findOne({
        where: { brandId: req.brandId, idempotencyKey: req.idempotencyKey },
      })
      if (refreshed?.metadata?.checkoutResult) {
        return refreshed.metadata.checkoutResult as CheckoutResult
      }
      if (refreshed) {
        return {
          paymentId: refreshed.id,
          status: refreshed.status,
          ...(refreshed.checkoutUrl ? { checkoutUrl: refreshed.checkoutUrl } : {}),
        }
      }
    }

    return {
      paymentId: existing.id,
      status: existing.status,
      ...(existing.checkoutUrl ? { checkoutUrl: existing.checkoutUrl } : {}),
    }
  }

  private async handleConcurrentIdempotentCheckout(
    req: CheckoutRequest,
    incomingFingerprint?: string,
    inFlightKey?: string,
  ): Promise<CheckoutResult> {
    if (inFlightKey) {
      const active = this.inFlightCheckouts.get(inFlightKey)
      if (active) {
        if (incomingFingerprint && active.fingerprint !== incomingFingerprint) {
          throw this.createIdempotencyConflictException()
        }
        return active.promise
      }
    }

    const existing = await this.paymentRepo.findOne({
      where: { brandId: req.brandId, idempotencyKey: req.idempotencyKey },
    })
    if (existing) {
      return this.resolveExistingIdempotentPayment(existing, req, incomingFingerprint)
    }

    throw this.createIdempotencyConflictException()
  }
}
