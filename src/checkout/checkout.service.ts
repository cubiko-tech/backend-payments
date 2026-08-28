import { HttpStatus, Injectable, Logger, OnModuleInit } from '@nestjs/common'
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
  checkoutUrl?: string      // Solo si provider es Stripe/MP
  subscriptionId?: string   // Solo si purpose es plan_purchase
  invoiceId?: string        // Solo si el pago fue inmediato
}

@Injectable()
export class CheckoutService implements OnModuleInit {
  private readonly log = new Logger(CheckoutService.name)
  private readonly BILLING_PERIOD_DAYS = parseInt(process.env.BILLING_PERIOD_DAYS || '30')

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

    // 3. Antes el precio salía de `req.currency` (COP por defecto) y coincidía con la
    // wallet por construcción; ahora la moneda es un dato DERIVADO del país de la marca,
    // así que hay que compararla contra la wallet ANTES de persistir y debitar. Acotado
    // a `plan_purchase`: es el único camino cuya moneda dejó de ser la del llamador.
    if (req.provider === 'wallet' && req.purpose === 'plan_purchase') {
      await this.assertWalletCurrency(req, currency)
    }

    // 4. El impuesto sigue saliendo del perfil de facturación —alinear los dos países
    // es una tarea aparte, con decisión de negocio—, SALVO cuando el precio se resolvió
    // en una moneda que no es COP: cobrar 19% de IVA colombiano sobre un precio en USD
    // no es un default conservador, es un total equivocado. Con COP el comportamiento
    // es idéntico al de hoy.
    const taxCountry = country && currency !== 'COP'
      ? country
      : await this.getBillingCountry(req.brandId)
    const tax = await this.taxService.getTaxForCountry(taxCountry)
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
      // Debitar wallet (atómico con pessimistic lock).
      //
      // La moneda viaja como 4º argumento SÓLO en el alta de plan, el mismo alcance que
      // `assertWalletCurrency`: es el único camino cuya moneda dejó de ser la del llamador
      // (sale del país de la marca). Un `service_payment` sigue cobrando lo que pide el
      // llamador y no gana un 422 que antes no existía. Es defensa en profundidad: el
      // pre-chequeo devuelve el 422 barato antes de persistir la fila de `payments`, y
      // `debit` vuelve a comparar sobre la fila ya bloqueada.
      //
      // DEUDA CONOCIDA (de otra tarea, no se toca acá): el `catch` de abajo reetiqueta
      // TODO fallo de wallet como `INSUFFICIENT_BALANCE` 400, así que si este respaldo
      // llegara a dispararse desde checkout saldría bajo el código equivocado. Destaparlo
      // también cambiaría el status de `WALLET_FROZEN`/`WALLET_CLOSED`/`INSUFFICIENT_BALANCE`,
      // que son previos a esta tarea y visibles para los clientes.
      await this.walletService.debit(req.walletId, totalAmount, {
        brandId: req.brandId,
        category: req.purpose === 'plan_purchase' ? 'plan_payment' : 'service_payment',
        description: req.purpose === 'plan_purchase'
          ? `Pago plan ${req.planSlug}`
          : 'Pago de servicio',
        referenceType: 'payment',
        referenceId: payment.id,
      }, req.purpose === 'plan_purchase' ? currency : undefined)
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
      const sub = await this.createOrRenewSubscription(req, payment)
      result.subscriptionId = sub.id

      // Asignar plan en backend-roles
      await this.assignPlanInRoles(req.brandId, req.planSlug)
    }

    // Generar factura
    const invoice = await this.generateInvoice(payment, req, subtotal, taxAmount, currency, tax)
    result.invoiceId = invoice.id

    // Enviar a DIAN (async, no bloquea)
    this.sendToDianAsync(invoice.id, currency)

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
        metadata: { paymentId: payment.id, buyer: req.buyer },
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
    const country = await this.getBillingCountry(payment.brandId)
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
    this.eventBus.notifyPaymentSuccess(payment.brandId, payment.id, String(payment.amount), payment.currency)
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
      throw new RequestException(
        { code: 'PAYMENT_NOT_FOUND', message: 'Pago no encontrado' },
        404,
      )
    }

    if (payment.status === PaymentStatus.COMPLETED) {
      return { status: 'completed', planSlug: payment.purposeId || undefined }
    }
    if (payment.status === PaymentStatus.FAILED) {
      return { status: 'failed' }
    }
    if (!payment.providerPaymentId) {
      return { status: payment.status }
    }

    try {
      const provider = this.providerFactory.getProvider(payment.provider)
      const real = await provider.getPaymentStatus(payment.providerPaymentId)

      if (real.status === 'completed') {
        await this.completeExternalPayment(paymentId, { source: 'reconcile', providerStatus: real.metadata })
        return { status: 'completed', planSlug: payment.purposeId || undefined }
      }

      return { status: real.status }
    } catch (error) {
      this.log.warn(`reconcilePayment: error consultando ${payment.provider} para ${paymentId}: ${error.message}`)
      return { status: payment.status }
    }
  }

  // =============================================================
  // Helpers
  // =============================================================

  /**
   * Resolver monto y moneda según el tipo de checkout.
   */
  private async resolveAmountAndCurrency(req: CheckoutRequest): Promise<ResolvedPricing> {
    if (req.purpose === 'plan_purchase' && req.planSlug) {
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

    if (!req.amount || !req.currency) {
      throw new RequestException({ code: 'MISSING_AMOUNT', message: 'Monto y moneda requeridos' })
    }

    return { amount: req.amount, currency: req.currency }
  }

  /**
   * Precio del plan por el camino LEGACY (moneda pedida por el llamador).
   * Conserva tal cual el comportamiento anterior; hoy sólo lo usa la renovación.
   */
  private async legacyPlanPrice(
    planSlug: string,
    currency: string,
  ): Promise<ResolvedPricing> {
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
  private async renewalPlanPrice(req: CheckoutRequest, legacyCurrency: string): Promise<ResolvedPricing> {
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
    if (req.purpose === 'plan_purchase' && !req.renewal) {
      return { ...req, brandId: this.assertUsableBrandId(req.brandId) }
    }
    const trimmed = typeof req.brandId === 'string' ? req.brandId.trim() : req.brandId
    return { ...req, brandId: trimmed }
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
   */
  private assertUsablePlanSlug(planSlug: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(planSlug)) {
      throw new RequestException(
        { code: 'INVALID_PLAN_SLUG', message: 'planSlug inválido' },
        HttpStatus.BAD_REQUEST,
      )
    }
  }

  /**
   * La wallet con la que se paga el plan tiene que ser de la marca y estar en la
   * moneda del precio resuelto.
   *
   * `WalletService.debit` sólo mira existencia, estado y saldo —el que compara
   * monedas es `transfer`—, así que sin esta guarda una marca US pagaría 6,99 USD
   * debitando 6,99 COP, o al revés. Se valida acá y no en `wallet.service.ts`,
   * que pertenece a la tarea hermana `guarda-de-moneda-en-wallet`.
   *
   * El `walletId` se EXIGE: `findById(undefined)` no falla, porque TypeORM descarta
   * las condiciones `undefined` (`invalidWhereValuesBehavior` por defecto) y la
   * consulta degenera en "la primera wallet de la tabla". Sin este rechazo la guarda
   * compararía la moneda de una wallet ajena —y filtraría cuál es en el mensaje—
   * mientras el débito posterior toca otra.
   *
   * La pertenencia se responde con el mismo 404 genérico de `findById`: decirle al
   * llamador "esa wallet existe pero no es tuya" convierte el error en un oráculo.
   *
   * Si la lectura de la wallet falla (no si no existe: eso ya lo rechaza `findById`
   * con 404) se deja seguir: el débito volverá a fallar por su cuenta.
   */
  private async assertWalletCurrency(req: CheckoutRequest, currency: string) {
    if (!req.walletId) {
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

    if (wallet.currency !== currency) {
      throw new RequestException(
        {
          code: 'WALLET_CURRENCY_MISMATCH',
          message: `La wallet está en ${wallet.currency} y el cobro es en ${currency}`,
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
  ): Promise<Subscription> {
    const now = new Date()
    const periodEnd = new Date()
    periodEnd.setDate(periodEnd.getDate() + this.BILLING_PERIOD_DAYS)

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
      // Invariante de `accessEndsAt`: no nula ⇔ hay una baja PENDIENTE. La marca que
      // canceló y después pagó ya no la tiene, y dejarle la fecha de corte vieja la
      // mostraría en `GET /subscription/current` sobre una suscripción que se renueva.
      subscription.accessEndsAt = null
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
  private async assignPlanInRoles(brandId: string, planSlug: string) {
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + this.BILLING_PERIOD_DAYS)
    await this.clientRoles.assignPlanToBrand(brandId, planSlug, expiresAt)
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
}
