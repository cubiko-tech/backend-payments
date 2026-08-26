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
  async processCheckout(req: CheckoutRequest): Promise<CheckoutResult> {
    // 0. Validar que el proveedor esté disponible para el país de la marca
    if (req.provider !== 'wallet') {
      const country = await this.getBillingCountry(req.brandId)
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

    // 1b. Antes el precio salía de `req.currency` (COP por defecto) y coincidía con la
    // wallet por construcción; ahora la moneda es un dato DERIVADO del país de la marca,
    // así que hay que compararla contra la wallet ANTES de persistir y debitar.
    if (req.provider === 'wallet') {
      await this.assertWalletCurrency(req.walletId, currency)
    }

    const tax = await this.taxService.getTaxForCountry(
      await this.getBillingCountry(req.brandId),
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
      const sub = await this.createOrRenewSubscription(req, payment)
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
  private async resolveAmountAndCurrency(req: CheckoutRequest): Promise<{ amount: number; currency: string }> {
    if (req.purpose === 'plan_purchase' && req.planSlug) {
      // Moneda pedida por el llamador. Sobrevive SÓLO para la renovación del cron:
      // ni el alta ni el precio negociado enterprise la usan.
      const legacyCurrency = req.currency || 'COP'

      // Se valida y normaliza UNA sola vez, antes de cualquier consulta con el id
      // (incluida la de `enterprise_pricing`), y se reescribe en la request para que
      // el mismo valor alimente el pago, la suscripción y la asignación de plan.
      req.brandId = this.assertUsableBrandId(req.brandId)

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

      // Renovación del cron: el comportamiento NO cambia. No se consulta el país,
      // no hay llamada HTTP nueva y no hay modo de fallo nuevo. Migrar la
      // renovación al catálogo por país implicaría cambiarle la moneda a
      // suscripciones vivas (payment.currency, factura y DIAN) contra un
      // proveedor nunca revalidado para esa moneda: es otra tarea. El log es la
      // única señal de qué marcas siguen cobrándose fuera del catálogo por país.
      if (req.renewal) {
        this.log.warn(
          `Renovación con precio legacy: brand=${req.brandId} plan=${req.planSlug} currency=${legacyCurrency}`,
        )
        return this.legacyPlanPrice(req.planSlug, legacyCurrency)
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
        throw this.planPricingException(req.planSlug, resolved.code, resolved.country)
      }

      return { amount: resolved.amount, currency: resolved.currency }
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
  ): Promise<{ amount: number; currency: string }> {
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
    | { ok: true; amount: number; currency: string; code?: never; country?: never }
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

    return {
      ok: true,
      amount: Number(price.price.price),
      currency: price.price.currency,
    }
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
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuid.test(normalized)) {
      throw new RequestException(
        { code: 'INVALID_BRAND_ID', message: 'brandId requerido y debe ser un UUID' },
        HttpStatus.BAD_REQUEST,
      )
    }
    return normalized
  }

  /**
   * La moneda de la wallet debe ser la del precio resuelto.
   *
   * `WalletService.debit` sólo mira existencia, estado y saldo —el que compara
   * monedas es `transfer`—, así que sin esta guarda una marca US pagaría 6,99 USD
   * debitando 6,99 COP, o al revés. Se valida acá y no en `wallet.service.ts`,
   * que pertenece a la tarea hermana `guarda-de-moneda-en-wallet`.
   *
   * Si la lectura de la wallet falla (no si no existe: eso ya lo rechaza
   * `findById` con 404) se deja seguir: el débito volverá a fallar por su cuenta.
   */
  private async assertWalletCurrency(walletId: string, currency: string) {
    const found = await this.walletService.findById(walletId)
    const wallet: Wallet = 'data' in found ? found.data : null
    if (wallet && wallet.currency !== currency) {
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
    country?: string,
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
        return new RequestException(
          {
            code: PRICE_NOT_FOUND_FOR_COUNTRY,
            message: `El plan '${planSlug}' no tiene precio para el país ${country}`,
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
