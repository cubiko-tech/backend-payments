/**
 * R6: CheckoutService keeps the end-to-end payment, subscription, invoice, DIAN,
 * and role-assignment orchestration together because immediate wallet settlements
 * and deferred external webhooks share the same transactional completion state.
 */
import { HttpStatus, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager, In, Raw, Repository } from 'typeorm'

import { WalletService } from '../wallet/wallet.service'
import { InvoiceService } from '../invoice/invoice.service'
import { SubscriptionService } from '../subscription/subscription.service'
import { AuditService } from '../audit/audit.service'
import { TaxService } from '../tax/tax.service'
import { resolveRechargeTax, validateRechargeTax } from '../tax/recharge-tax'
import { breakDownTaxInclusiveAmount } from '../tax/tax-inclusive-breakdown'
import { DianService } from '../dian/dian.service'
import { ProviderFactory } from '../provider/provider.factory'
import { EventBusService } from '../event-bus/event-bus.service'
import { TrmService, UsdCopRate, exchangeRateUnavailable } from '../trm/trm.service'
import { TokenWalletService } from '../wallet/token-wallet.service'
import { TokenPackageService } from '../wallet/token-package.service'

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
  PLAN_APPLYING_EVENTS,
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
import { escapeLogValue } from '../shared/logger/log-value'
import { ConfioApiError } from '../provider/confio/confio-api-error'
import {
  buildIdempotencyFingerprint,
  createRetryExpiredException,
  handleConcurrentIdempotentCheckout,
  InFlightCheckoutsMap,
  isRetryWindowOpen,
  isUniqueConstraintViolation,
  normalizeIdempotencyKey,
  paymentBirth,
  resolveExistingIdempotentPayment,
} from './checkout-idempotency'
import { checkoutExpiryHours } from './checkout-expiry'
import {
  hasWalletPaymentDebit,
  isLastPaymentNewer,
  reconcileWalletPayment as executeWalletPaymentReconciliation,
  WalletPaymentReconciliationResult,
} from './wallet-payment-reconciliation'
import {
  claimFailedPaymentForRetry,
  closeWalletPayment,
  readPaymentAfterSweep,
  WalletCheckoutLostError,
  WalletCloseResult,
} from './wallet-payment-close'
import {
  closeExternalPlanPurchase,
  completeExternalPlanPurchase,
  hasPaymentTakenEffect,
  LOST_TO_NEWER_PURCHASE_FLAG,
  settleLostExternalPurchase,
} from './external-payment-close'
import { issueRefundCreditNote } from './refund-credit-note'
import {
  creditTokenAmount,
  creditTokenPackage,
  PreparedTokenAmount,
  PreparedTokenPackage,
  prepareTokenAmount,
  prepareTokenPackage,
} from './token-package-checkout'

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
  purpose:
    | 'plan_purchase'
    | 'wallet_recharge'
    | 'service_payment'
    | 'token_package'
    | 'token_amount'
  provider: 'wallet' | 'stripe' | 'mercadopago' | 'dropi' | 'confio'
  // Para plan_purchase
  planSlug?: string
  // Para wallet_recharge / service_payment
  amount?: number
  currency?: string
  walletId?: string
  // token_package: the catalog row; price and tokens come from it, never from the body
  packageId?: string
  // token_amount: the token count chosen by the brand; priced in Payments at TOKEN_PRICE_USD
  tokens?: number
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
  private readonly inFlightCheckouts: InFlightCheckoutsMap = new Map()
  private readonly inFlightCompletions = new Set<string>()
  private readonly walletReconcileLocks = new Map<string, Promise<void>>()
  // A credit note waits this long for an invoice already on its way: Siigo can take 45 s.
  private readonly dianInFlightWaitMs = 2 * 60 * 1000

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
    // Optional: only a token package paid in COP needs it, and without it that checkout fails closed.
    @Optional() private trmService?: TrmService,
    // Optional for the same reason: only a token_package checkout needs them, and fails closed without.
    @Optional() private tokenWallets?: TokenWalletService,
    @Optional() private tokenPackages?: TokenPackageService,
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
    const idempotencyFingerprint = req.idempotencyKey ? buildIdempotencyFingerprint(req) : undefined

    if (req.idempotencyKey) {
      const existing = await this.paymentRepo.findOne({
        where: { brandId: req.brandId, idempotencyKey: req.idempotencyKey },
      })
      if (existing) {
        return resolveExistingIdempotentPayment(
          existing,
          req,
          this.paymentRepo,
          this.inFlightCheckouts,
          idempotencyFingerprint,
          (failedPayment) =>
            this.retryFailedIdempotentPayment(failedPayment, req, idempotencyFingerprint),
          (pendingPayment) =>
            hasWalletPaymentDebit(pendingPayment, {
              walletService: this.walletService,
              dataSource: this.dataSource,
            }),
        )
      }
    }

    // 1. Precio y moneda. En `plan_purchase` los decide el país REGISTRADO de la
    // marca; `country` viene informado SÓLO cuando el precio salió del catálogo por
    // país (no en el precio negociado enterprise ni en el fallback legacy).
    const tokenPackage =
      req.purpose === 'token_package' ? await this.prepareTokenPackage(req) : undefined
    const tokenAmount =
      req.purpose === 'token_amount' ? await this.prepareTokenAmount(req) : undefined
    const tokenCheckout = tokenPackage ?? tokenAmount
    const { amount, currency, country } =
      tokenCheckout ?? (await this.resolveAmountAndCurrency(req))
    const rate = tokenCheckout?.rate

    // 2. El proveedor se valida contra el MISMO país que decidió el precio. Gatear
    // por el perfil de facturación (`|| 'CO'`) mientras el monto viaja en la moneda
    // del país de la marca dejaba pasar un cobro en USD a un proveedor habilitado
    // sólo para CO y nunca validado para esa moneda.
    if (req.provider !== 'wallet' && !tokenCheckout) {
      // Not for a token checkout: prepareTokenPackage/prepareTokenAmount checked it before quoting the TRM.
      await this.assertProviderAvailable(req, country)
    }

    // 3. Pre-validate wallet ownership, non-TKN currency, and currency match
    // before persisting the payment or debiting across any checkout purpose.
    if (
      // A token checkout ignores the body's walletId: its wallet is the brand token wallet.
      !tokenCheckout &&
      (req.provider === 'wallet' || req.purpose === 'wallet_recharge' || req.walletId)
    ) {
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
    const tax =
      isWalletRecharge || tokenCheckout
        ? await resolveRechargeTax(this.taxService, taxCountry, this.log)
        : await this.taxService.getTaxForCountry(taxCountry)
    const directTaxBreakdown = isWalletConsumption
      ? null
      : breakDownTaxInclusiveAmount(amount, tax.taxRate)
    const subtotalAmount = directTaxBreakdown ? directTaxBreakdown.subtotal : amount
    const taxAmount = directTaxBreakdown ? directTaxBreakdown.taxAmount : 0
    const totalAmount = directTaxBreakdown ? directTaxBreakdown.totalAmount : amount

    // 2. Crear registro de pago
    const payment = this.paymentRepo.create({
      brandId: req.brandId,
      userId: req.userId,
      ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
      walletId: tokenCheckout ? tokenCheckout.walletId : req.walletId || null,
      provider: req.provider as PaymentProvider,
      amount: totalAmount,
      currency,
      ...(rate ? { exchangeRate: rate.rate, exchangeRateDate: rate.date } : {}),
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
        ...(tokenPackage ? { tokenPackage: tokenPackage.snapshot } : {}),
        ...(tokenAmount ? { tokenAmount: tokenAmount.snapshot } : {}),
      },
    })

    const inFlightKey = req.idempotencyKey ? `${req.brandId}:${req.idempotencyKey}` : undefined
    try {
      const savedPayment = await this.paymentRepo.save(payment)
      if (savedPayment?.id && !payment.id) {
        payment.id = savedPayment.id
      }
    } catch (error) {
      if (req.idempotencyKey && isUniqueConstraintViolation(error)) {
        return handleConcurrentIdempotentCheckout(
          req,
          this.paymentRepo,
          this.inFlightCheckouts,
          idempotencyFingerprint,
          inFlightKey,
          (failedPayment) =>
            this.retryFailedIdempotentPayment(failedPayment, req, idempotencyFingerprint),
        )
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

  private prepareTokenPackage(req: CheckoutRequest): Promise<PreparedTokenPackage> {
    return prepareTokenPackage(req, {
      tokenPackages: this.tokenPackages,
      tokenWallets: this.tokenWallets,
      billingCountry: (brandId) => this.getBillingCountry(brandId),
      assertProviderAvailable: (country) => this.assertProviderAvailable(req, country),
      quoteUsdCopRate: () => this.quoteUsdCopRate(),
    })
  }

  private prepareTokenAmount(req: CheckoutRequest): Promise<PreparedTokenAmount> {
    return prepareTokenAmount(req, {
      tokenWallets: this.tokenWallets,
      billingCountry: (brandId) => this.getBillingCountry(brandId),
      assertProviderAvailable: (country) => this.assertProviderAvailable(req, country),
      quoteUsdCopRate: () => this.quoteUsdCopRate(),
    })
  }

  private async quoteUsdCopRate(): Promise<UsdCopRate> {
    if (!this.trmService) throw exchangeRateUnavailable()
    return this.trmService.getUsdCopRate()
  }

  private async assertProviderAvailable(req: CheckoutRequest, country?: string) {
    // The deprecated `dropi` provider sells no token package or token amount, on checkout or retry.
    if (
      (req.purpose === 'token_package' || req.purpose === 'token_amount') &&
      req.provider === PaymentProvider.DROPI
    ) {
      throw new RequestException({
        code: 'PROVIDER_NOT_AVAILABLE',
        message: `Provider '${req.provider}' does not sell token packages`,
      })
    }
    const gateCountry = country || (await this.getBillingCountry(req.brandId))
    const available = await this.providerConfig.isProviderAvailable(gateCountry, req.provider)
    if (!available) {
      throw new RequestException({
        code: 'PROVIDER_NOT_AVAILABLE',
        message: `Proveedor '${req.provider}' no disponible para el país ${gateCountry}`,
      })
    }
  }

  /**
   * Rejects, with nothing written, a retry that may not charge. A payment with a debit is exempt
   * from the window: the retry charges nothing and only closes what the buyer already paid.
   */
  private async assertRetryAllowed(existing: Payment, req: CheckoutRequest) {
    if (
      !isRetryWindowOpen(existing) &&
      !(await hasWalletPaymentDebit(existing, {
        walletService: this.walletService,
        dataSource: this.dataSource,
      }))
    ) {
      throw createRetryExpiredException(existing)
    }
    if (req.provider !== 'wallet') {
      await this.assertProviderAvailable(req, existing.metadata?.country)
    }
  }

  private async retryFailedIdempotentPayment(
    existing: Payment,
    req: CheckoutRequest,
    idempotencyFingerprint?: string,
  ): Promise<CheckoutResult> {
    const inFlightKey = req.idempotencyKey ? `${req.brandId}:${req.idempotencyKey}` : undefined
    const runRetry = async (): Promise<CheckoutResult> => {
      await this.assertRetryAllowed(existing, req)

      const retryNow = new Date()
      const retryMetadata = {
        ...(existing.metadata || {}),
        firstAttemptAt: paymentBirth(existing).toISOString(),
      }
      delete retryMetadata.checkoutResult

      const claimed = await claimFailedPaymentForRetry(
        existing.id,
        {
          status: PaymentStatus.PENDING,
          failureReason: null,
          metadata: retryMetadata,
        },
        retryNow,
        this.dataSource,
      )

      if (claimed && claimed.affected === 0) {
        const current = await this.paymentRepo.findOne({
          where: { brandId: req.brandId, idempotencyKey: req.idempotencyKey },
        })
        if (current) {
          return resolveExistingIdempotentPayment(
            current,
            req,
            this.paymentRepo,
            new Map(),
            idempotencyFingerprint,
          )
        }
      }

      existing.status = PaymentStatus.PENDING
      existing.failureReason = null
      existing.createdAt = claimed.createdAt ?? existing.createdAt
      existing.metadata = retryMetadata

      const totalAmount = Number(existing.amount)
      const currency = existing.currency
      const taxAmount =
        existing.metadata?.taxAmount !== undefined ? Number(existing.metadata.taxAmount) : 0
      const subtotalAmount =
        existing.metadata?.subtotal !== undefined
          ? Number(existing.metadata.subtotal)
          : Math.round((totalAmount - taxAmount) * 100) / 100
      const tax =
        existing.metadata?.taxRate !== undefined
          ? {
              taxRate: Number(existing.metadata.taxRate),
              taxName: existing.metadata.taxName || 'IVA',
            }
          : null

      return this.executeCheckoutPayment(
        existing,
        req,
        subtotalAmount,
        taxAmount,
        totalAmount,
        currency,
        tax,
      )
    }

    const executionPromise = runRetry()
    if (inFlightKey) {
      this.inFlightCheckouts.set(inFlightKey, {
        fingerprint: idempotencyFingerprint,
        promise: executionPromise,
      })
    }
    try {
      return await executionPromise
    } finally {
      if (inFlightKey) {
        this.inFlightCheckouts.delete(inFlightKey)
      }
    }
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
      const markedFailed = await this.paymentRepo.update(
        { id: payment.id, status: PaymentStatus.PENDING },
        { status: PaymentStatus.FAILED, failureReason: error.message },
      )
      if (!markedFailed.affected) {
        const latest = await this.paymentRepo.findOne({ where: { id: payment.id } })
        if (latest?.status === PaymentStatus.COMPLETED && latest.metadata?.checkoutResult) {
          return latest.metadata.checkoutResult as CheckoutResult
        }
      }

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
    const result: CheckoutResult = {
      paymentId: payment.id,
      status: 'completed',
    }

    let closed: WalletCloseResult
    try {
      closed = await this.closeWalletPayment(payment, req)
    } catch (error) {
      await this.handPaymentToSweep(payment.id)
      throw error
    }
    if (closed.outcome === 'superseded') {
      throw this.walletCheckoutLostError(payment.id)
    }
    if (closed.outcome === 'already_closed') {
      const settled = await readPaymentAfterSweep(payment.id, this.dataSource)
      if (settled?.status !== PaymentStatus.COMPLETED) {
        throw this.walletCheckoutLostError(payment.id)
      }
      return (settled.metadata?.checkoutResult as CheckoutResult) ?? result
    }

    payment.status = PaymentStatus.COMPLETED
    payment.paidAt = closed.paidAt
    const sub = closed.subscription
    if (sub) {
      result.subscriptionId = sub.id
      if (closed.extended && sub.currentPeriodEnd) {
        result.renewal = 'extended'
        result.currentPeriodEnd = sub.currentPeriodEnd
      }
      // Outside the brand lock: backend-roles is HTTP.
      await this.assignCurrentPlanInRoles(req.brandId, sub.planSlug, sub.currentPeriodEnd)
    }

    await this.auditService.log(
      req.userId,
      'checkout_completed',
      'payment',
      payment.id,
      { purpose: req.purpose, planSlug: req.planSlug, amount: totalAmount, provider: 'wallet' },
      `Checkout completado: ${req.purpose} por ${currency} ${totalAmount}`,
    )

    if (req.idempotencyKey) {
      payment.metadata = {
        ...(payment.metadata || {}),
        checkoutResult: result,
      }
      await this.paymentRepo.update(
        { id: payment.id, status: PaymentStatus.COMPLETED },
        { metadata: payment.metadata },
      )
    }

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

    this.log.log(
      `Checkout completado: payment=${payment.id} brand=${req.brandId} plan=${req.planSlug}`,
    )
    return result
  }

  private closeWalletPayment(payment: Payment, req: CheckoutRequest) {
    return closeWalletPayment(payment, req, {
      dataSource: this.dataSource,
      createOrRenewSubscription: (r, p, manager) => this.createOrRenewSubscription(r, p, manager),
    })
  }

  /**
   * Leaves a debited payment whose close failed to the sweep. Never throws, so the close
   * error reaches the caller; a payment this write misses stays `pending`, also swept.
   */
  private async handPaymentToSweep(paymentId: string) {
    try {
      await this.paymentRepo.update(
        { id: paymentId, status: PaymentStatus.PENDING },
        { status: PaymentStatus.PROCESSING },
      )
    } catch (error) {
      this.log.error(`Could not hand payment ${paymentId} to the sweep: ${error.message}`)
    }
  }

  /** The payment lost to the sweep or to a newer purchase; the sweep settles its money. */
  private walletCheckoutLostError(paymentId: string) {
    return new WalletCheckoutLostError(
      {
        code: 'WALLET_DEBIT_FAILED',
        message: `Payment ${paymentId} was closed by another process`,
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    )
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
      payment.expiresAt = new Date(Date.now() + checkoutExpiryHours() * 3600000)
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
      this.logExternalCheckoutRejection(payment.id, req.provider, error)
      payment.status = PaymentStatus.FAILED
      payment.failureReason = error.message
      await this.paymentRepo.save(payment)

      throw new RequestException({
        code: 'PROVIDER_ERROR',
        message: `Error con ${req.provider}: ${error.message}`,
      })
    }
  }

  /** One diagnostic line per rejected checkout: never the body, the payment link or buyer data. */
  private logExternalCheckoutRejection(paymentId: string, provider: string, error: unknown) {
    const confio = error instanceof ConfioApiError ? error : undefined
    this.log.warn(
      `External checkout rejected: payment=${paymentId} provider=${escapeLogValue(provider)} ` +
        `status=${confio?.status ?? 'n/a'} code=${escapeLogValue(confio?.providerCode ?? 'n/a')}`,
    )
  }

  /**
   * Completar pago externo (llamado desde webhook).
   * Este es el flujo que ejecuta el webhook cuando Stripe/MP/Dropi confirma el pago.
   *
   * @returns true only if this call left the payment `completed`.
   */
  async completeExternalPayment(
    paymentId: string,
    providerData?: Record<string, unknown>,
    expectedProvider?: PaymentProvider | string,
  ): Promise<boolean> {
    if (this.inFlightCompletions.has(paymentId)) return false
    this.inFlightCompletions.add(paymentId)
    try {
      const payment = await this.paymentRepo.findOne({
        where: {
          id: paymentId,
          ...(expectedProvider ? { provider: expectedProvider as PaymentProvider } : {}),
        },
      })
      if (
        !payment ||
        (expectedProvider && payment.provider !== expectedProvider) ||
        payment.provider === PaymentProvider.WALLET ||
        payment.status === PaymentStatus.COMPLETED ||
        payment.status === PaymentStatus.REFUNDED ||
        this.hasAmountMismatchMark(payment)
      ) {
        return false
      }

      const previousStatus = payment.status
      const previousMetadata = payment.metadata
      const isNotice = Boolean(expectedProvider) || this.isProviderNoticePayload(providerData)
      const metadata = providerData ? { ...payment.metadata, providerData } : payment.metadata
      const claimed = await this.paymentRepo.update(
        // This write replaces `metadata`: from a stale read it would erase the lost flag.
        {
          id: paymentId,
          status: payment.status,
          ...(expectedProvider ? { provider: expectedProvider as PaymentProvider } : {}),
          ...(providerData && !payment.metadata?.[LOST_TO_NEWER_PURCHASE_FLAG]
            ? {
                metadata: Raw((column) => `(${column})->>'${LOST_TO_NEWER_PURCHASE_FLAG}' IS NULL`),
              }
            : {}),
        },
        {
          status: PaymentStatus.PROCESSING,
          ...(providerData ? { metadata } : {}),
        },
      )
      if (!claimed.affected) return false

      return await this.finalizeProcessingPayment(
        payment,
        paymentId,
        providerData,
        metadata,
        isNotice,
        previousStatus,
        previousMetadata,
      )
    } finally {
      this.inFlightCompletions.delete(paymentId)
    }
  }

  private async finalizeProcessingPayment(
    payment: Payment,
    paymentId: string,
    providerData?: any,
    metadata?: any,
    isNotice = false,
    previousStatus: PaymentStatus = PaymentStatus.PENDING,
    previousMetadata?: Payment['metadata'],
  ): Promise<boolean> {
    payment.status = PaymentStatus.PROCESSING
    if (providerData) {
      payment.metadata = metadata
    }

    const totalAmount = parseFloat(String(payment.amount))
    const amountConfirmed = await this.assertProviderConfirmedAmount(
      payment,
      totalAmount,
      providerData,
      isNotice,
      previousStatus,
      previousMetadata,
    )
    if (!amountConfirmed) return false

    const isPlanPurchase = payment.purpose === PaymentPurpose.PLAN_PURCHASE && !!payment.purposeId
    let extendedUntil: Date | undefined

    // Ahead of the taxes: a purchase that lost gets its money back without needing an invoice.
    if (isPlanPurchase) {
      // One transaction: a crash between the subscription and its event would add the days twice.
      const closed = await closeExternalPlanPurchase(
        payment,
        {
          brandId: payment.brandId,
          userId: payment.userId,
          provider: payment.provider as any,
          purpose: 'plan_purchase',
          planSlug: payment.purposeId,
          walletId: payment.walletId,
        },
        this.dataSource,
        (req, p, manager) => this.createOrRenewSubscription(req, p, manager),
      )
      if (closed.outcome === 'superseded') {
        await this.settleLostPurchase(paymentId)
        return false
      }
      if (closed.extended && closed.subscription?.currentPeriodEnd) {
        extendedUntil = closed.subscription.currentPeriodEnd
      }
      await this.assignCurrentPlanInRoles(
        payment.brandId,
        closed.subscription?.planSlug || payment.purposeId,
        closed.subscription?.currentPeriodEnd,
      )
    }

    // Calcular impuestos para factura. El país sale del pago —lo decidió el checkout con
    // el mismo criterio que el precio—, y el perfil de facturación queda de respaldo para
    // los pagos anteriores a este cambio, que no lo llevan.
    const country = payment.metadata?.country || (await this.getBillingCountry(payment.brandId))
    const isWalletRecharge = payment.purpose === PaymentPurpose.WALLET_RECHARGE
    const isTokenPackage = payment.purpose === PaymentPurpose.TOKEN_PACKAGE
    const isTokenAmount = payment.purpose === PaymentPurpose.TOKEN_AMOUNT
    // Token purchases are invoiced as a recharge: strict VAT, included in what was paid.
    const takesRechargeTax = isWalletRecharge || isTokenPackage || isTokenAmount
    const hasSavedTaxRate =
      payment.metadata &&
      payment.metadata.taxRate !== undefined &&
      payment.metadata.taxRate !== null &&
      Number.isFinite(Number(payment.metadata.taxRate)) &&
      Number(payment.metadata.taxRate) >= 0

    let tax: { taxName: string; taxRate: number; isInclusive: boolean }
    if (takesRechargeTax && hasSavedTaxRate) {
      tax = validateRechargeTax(
        country,
        {
          taxName: String(payment.metadata.taxName || ''),
          taxRate: Number(payment.metadata.taxRate),
          isInclusive: true,
        },
        this.log,
      )
    } else if (takesRechargeTax) {
      tax = await resolveRechargeTax(this.taxService, country, this.log)
    } else if (hasSavedTaxRate) {
      tax = {
        taxName: String(payment.metadata.taxName || 'N/A'),
        taxRate: Number(payment.metadata.taxRate),
        isInclusive: true,
      }
    } else {
      tax = await this.taxService.getTaxForCountry(country)
    }

    const { subtotal, taxAmount } = breakDownTaxInclusiveAmount(totalAmount, tax.taxRate)

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
    if (isTokenPackage) {
      await creditTokenPackage(payment, this.tokenWallets)
    }
    if (isTokenAmount) {
      await creditTokenAmount(payment, this.tokenWallets)
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
    if (isPlanPurchase) {
      const outcome = await completeExternalPlanPurchase(payment, paidAt, this.dataSource)
      if (outcome === 'superseded') {
        await this.settleLostPurchase(paymentId)
        return false
      }
      if (outcome !== 'completed') return false
    } else {
      const completed = await this.paymentRepo.update(
        { id: paymentId, status: PaymentStatus.PROCESSING },
        {
          status: PaymentStatus.COMPLETED,
          paidAt,
        },
      )
      if (!completed.affected) return false
    }

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
    return true
  }

  private async settleLostPurchase(paymentId: string) {
    const settled = await settleLostExternalPurchase(paymentId, {
      paymentRepo: this.paymentRepo,
      walletService: this.walletService,
      dataSource: this.dataSource,
      inProcessLocks: this.walletReconcileLocks,
      auditService: this.auditService,
      logger: this.log,
    })
    // Also on a noop: another instance may have refunded it before this one's invoice existed.
    if (settled.status === PaymentStatus.REFUNDED) {
      await this.issueRefundCreditNote(paymentId)
    }
    return settled
  }

  /** Reverses the invoice of a purchase refunded to the wallet, if it has one. Never throws. */
  issueRefundCreditNote(paymentId: string) {
    return issueRefundCreditNote(paymentId, {
      invoiceService: this.invoiceService,
      dianService: this.dianService,
      auditService: this.auditService,
      dataSource: this.dataSource,
      logger: this.log,
      canSendToDian: (invoiceId, currency) => this.canSendToDian(invoiceId, currency),
      dianInFlightWaitMs: this.dianInFlightWaitMs,
    })
  }

  /**
   * What the return page gets once the provider confirmed. A credited purchase answers `failed`,
   * which that page already ends on, plus the flag; `processing` while its credit is pending.
   */
  private confirmedPaymentAnswer(
    current: Payment | null,
    planSlug?: string,
  ): { status: string; planSlug?: string; refundedToWallet?: boolean } {
    if (current?.status === PaymentStatus.REFUNDED) {
      return { status: 'failed', refundedToWallet: true }
    }
    if (current?.status === PaymentStatus.FAILED || this.hasAmountMismatchMark(current)) {
      return { status: 'failed' }
    }
    if (
      current?.status === PaymentStatus.PROCESSING &&
      (current.paidAt || current.metadata?.[LOST_TO_NEWER_PURCHASE_FLAG])
    ) {
      return { status: 'processing' }
    }
    return { status: 'completed', planSlug }
  }

  /**
   * Reconciles a payment against the provider's live status and completes it when confirmed
   * (idempotent with the webhook). The return page calls it with the session's brand guard; the
   * sweep does not call it (it uses `completeExternalPayment`).
   * @param canAccessBrand brand guard of the caller's session, or `null` from an internal caller
   *   without a session. `undefined` throws: skipping the guard has to be declared.
   * @throws RequestException 404 PAYMENT_NOT_FOUND when the payment is missing or the guard denies it.
   */
  async reconcilePayment(
    paymentId: string,
    canAccessBrand: ((brandId: string) => Promise<boolean>) | null,
  ): Promise<{ status: string; planSlug?: string; refundedToWallet?: boolean }> {
    if (canAccessBrand === undefined) {
      throw new Error('reconcilePayment requires a brand guard or an explicit null')
    }
    const payment = await this.paymentRepo.findOne({ where: { id: paymentId } })
    if (!payment || (canAccessBrand && !(await canAccessBrand(payment.brandId)))) {
      throw new RequestException({ code: 'PAYMENT_NOT_FOUND', message: 'Pago no encontrado' }, 404)
    }

    if (payment.status === PaymentStatus.REFUNDED && payment.provider !== PaymentProvider.WALLET) {
      return this.confirmedPaymentAnswer(payment)
    }
    if (payment.status === PaymentStatus.COMPLETED) {
      return { status: 'completed', planSlug: payment.purposeId || undefined }
    }
    if (payment.status === PaymentStatus.FAILED || this.hasAmountMismatchMark(payment)) {
      return { status: 'failed' }
    }
    if (!payment.providerPaymentId) {
      if (
        payment.status === PaymentStatus.PROCESSING &&
        payment.provider !== PaymentProvider.WALLET
      ) {
        try {
          await this.completeExternalPayment(paymentId, { source: 'reconcile' })
          const afterReconcile = await this.paymentRepo.findOne({ where: { id: paymentId } })
          return this.confirmedPaymentAnswer(afterReconcile, payment.purposeId || undefined)
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
      const real = await provider.getPaymentStatus(payment.providerPaymentId, payment.id)

      if (real.status === 'completed') {
        await this.completeExternalPayment(paymentId, {
          source: 'reconcile',
          providerStatus: real.metadata,
        })
        const afterReconcile = await this.paymentRepo.findOne({ where: { id: paymentId } })
        return this.confirmedPaymentAnswer(afterReconcile, payment.purposeId || undefined)
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

  async reconcileWalletPayment(
    paymentId: string,
    now?: Date,
  ): Promise<WalletPaymentReconciliationResult> {
    return executeWalletPaymentReconciliation(
      paymentId,
      {
        paymentRepo: this.paymentRepo,
        subscriptionRepo: this.subscriptionRepo,
        subscriptionEventRepo: this.subscriptionEventRepo,
        walletService: this.walletService,
        dataSource: this.dataSource,
        inProcessLocks: this.walletReconcileLocks,
        logger: this.log,
        closeWalletPayment: (p, req) => this.closeWalletPayment(p, req),
        assignPlanInRoles: (brandId, planSlug, expiresAt) =>
          this.assignCurrentPlanInRoles(brandId, planSlug, expiresAt),
        auditService: this.auditService,
        eventBus: this.eventBus,
      },
      now,
    )
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

    if (
      (req.purpose !== 'token_package' && req.packageId !== undefined) ||
      (req.purpose !== 'token_amount' && req.tokens !== undefined)
    ) {
      throw new RequestException(
        {
          code: 'CONFLICTING_TOKEN_FIELDS',
          message: 'packageId is only allowed for token_package and tokens only for token_amount',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    const idempotencyKey =
      req.idempotencyKey === undefined ? undefined : normalizeIdempotencyKey(req.idempotencyKey)

    if (req.purpose === 'token_amount' && !idempotencyKey) {
      throw new RequestException(
        {
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key is required for token_amount checkouts',
        },
        HttpStatus.BAD_REQUEST,
      )
    }

    if (req.idempotencyKey === undefined) {
      return { ...req, brandId }
    }

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
    // `findById` throws 404 for an unknown id; no wallet here means its read failed.
    if (!wallet) {
      throw new RequestException(
        { code: 'WALLET_LOOKUP_UNAVAILABLE', message: 'Could not read the wallet' },
        HttpStatus.SERVICE_UNAVAILABLE,
      )
    }

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
    manager?: EntityManager,
  ): Promise<{ subscription: Subscription; extended: boolean }> {
    const subscriptionRepo = manager?.getRepository(Subscription) ?? this.subscriptionRepo
    const subscriptionEventRepo =
      manager?.getRepository(SubscriptionEvent) ?? this.subscriptionEventRepo
    const now = new Date()
    const periodEnd = new Date()
    periodEnd.setDate(periodEnd.getDate() + this.BILLING_PERIOD_DAYS)

    // Buscar suscripción existente
    let subscription = await subscriptionRepo.findOne({
      where: { brandId: req.brandId },
    })

    if (subscription) {
      if (payment?.id) {
        const existingEvent = await subscriptionEventRepo.findOne({
          where: { paymentId: payment.id, eventType: In(PLAN_APPLYING_EVENTS) },
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
      // An older purchase of this plan extends it, but the newest purchase stays named:
      // the close of another plan decides its conflict by this payment's createdAt.
      const keepsNewerPayment =
        fromPlan === req.planSlug &&
        !!subscription.lastPaymentId &&
        (await isLastPaymentNewer(
          subscription.lastPaymentId,
          payment,
          manager?.getRepository(Payment) ?? this.paymentRepo,
        ))
      if (!keepsNewerPayment) {
        subscription.lastPaymentId = payment.id
      }
      subscription.retryCount = 0
      subscription.cancelledAt = null
      subscription.cancelReason = null
      // Invariante de `accessEndsAt`: no nula ⇔ hay una baja PENDIENTE. La marca que
      // canceló y después pagó ya no la tiene, y dejarle la fecha de corte vieja la
      // mostraría en `GET /subscription/current` sobre una suscripción que se renueva.
      subscription.accessEndsAt = null
      subscription.autoRenew = true

      await subscriptionRepo.save(subscription)

      // Registrar evento
      const eventType =
        fromPlan !== req.planSlug
          ? SubscriptionEventType.PLAN_CHANGED
          : SubscriptionEventType.RENEWED

      await subscriptionEventRepo.save(
        subscriptionEventRepo.create({
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
      subscription = subscriptionRepo.create({
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
      await subscriptionRepo.save(subscription)

      await subscriptionEventRepo.save(
        subscriptionEventRepo.create({
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
    } else if (req.purpose === 'token_package') {
      items.push({
        description: tokenPackageInvoiceDescription(payment),
        quantity: 1,
        unitPrice: subtotal,
        subtotal,
        taxRate: tax.taxRate ?? 0,
        taxAmount,
        total: invoiceTotal,
        productType: 'token_package',
        referenceType: 'payment',
        referenceId: payment.id,
      })
    } else if (req.purpose === 'token_amount') {
      items.push({
        description: tokenAmountInvoiceDescription(payment),
        quantity: 1,
        unitPrice: subtotal,
        subtotal,
        taxRate: tax.taxRate ?? 0,
        taxAmount,
        total: invoiceTotal,
        productType: 'token_amount',
        referenceType: 'payment',
        referenceId: payment.id,
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
      ...(req.purpose === 'wallet_recharge' ||
      req.purpose === 'token_package' ||
      req.purpose === 'token_amount'
        ? {
            metadata: {
              serviceDescription:
                req.purpose === 'token_package'
                  ? tokenPackageInvoiceDescription(payment)
                  : req.purpose === 'token_amount'
                    ? tokenAmountInvoiceDescription(payment)
                    : 'Créditos de uso de la plataforma ROAX',
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
        providerData?.amount ?? providerData?.data?.amount ?? providerData?.providerStatus?.amount,
    },
    // Its webhook omits the amount; only its status answer brings it.
    [PaymentProvider.MERCADOPAGO]: {
      verifiesAmount: true,
      unit: 'major',
      extractConfirmedAmount: (providerData: any) =>
        providerData?.providerStatus?.transactionAmount,
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

  private isProviderNoticePayload(providerData?: any): boolean {
    if (!providerData || typeof providerData !== 'object') return false
    return typeof providerData.source !== 'string' || providerData.source.length === 0
  }

  private async assertProviderConfirmedAmount(
    payment: Payment,
    expectedAmount: number,
    providerData?: any,
    isNotice = false,
    previousStatus: PaymentStatus = PaymentStatus.PENDING,
    previousMetadata?: Payment['metadata'],
  ): Promise<boolean> {
    const providerKey = String(payment.provider || '').toLowerCase()
    const spec = this.providerConfirmedAmountSpecs[providerKey]
    if (!spec || !spec.verifiesAmount) {
      return true
    }
    const rawCandidate =
      (providerData && typeof providerData === 'object'
        ? spec.extractConfirmedAmount(providerData)
        : undefined) ??
      (payment.metadata?.providerData && typeof payment.metadata.providerData === 'object'
        ? spec.extractConfirmedAmount(payment.metadata.providerData)
        : undefined)
    if (
      rawCandidate === undefined ||
      rawCandidate === null ||
      rawCandidate === '' ||
      !Number.isFinite(Number(rawCandidate))
    ) {
      if (!isNotice) {
        return true
      }
      this.log.warn(
        `Provider ${providerKey} notice for payment ${payment.id} omitted confirmed amount; deferring to reconciliation`,
      )
      await this.paymentRepo.update(
        { id: payment.id, status: PaymentStatus.PROCESSING },
        { status: previousStatus, metadata: previousMetadata },
      )
      payment.status = previousStatus
      payment.metadata = previousMetadata
      return false
    }
    const numericConfirmed = Number(rawCandidate)
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
      // What was given stays given: `failed` would leave it in place with nothing to revert it.
      if (await hasPaymentTakenEffect(payment.id, this.dataSource)) return true
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
    return true
  }

  /**
   * Enviar factura a DIAN en background (no bloquea el checkout).
   */
  private sendToDianAsync(invoiceId: string, currency: string) {
    if (!this.canSendToDian(invoiceId, currency)) return

    // Fire and forget: the buyer's response does not wait for the DIAN.
    this.dianService.sendInvoice(invoiceId).catch((error) => {
      winstonLogger.log('error', `Error enviando factura ${invoiceId} a DIAN: ${error.message}`)
    })
  }

  private canSendToDian(invoiceId: string, currency: string): boolean {
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
      return false
    }

    return this.dianService.isConfigured()
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
   * Sends the subscription's current plan and period to backend-roles, the given ones if it has
   * none. Sends again if they changed during the call: two closes race over HTTP, and whichever
   * answers last has seen the other's close, so the last write ends up being the current one.
   */
  private async assignCurrentPlanInRoles(brandId: string, planSlug: string, expiresAt?: Date) {
    const read = () => this.subscriptionRepo.findOne({ where: { brandId } })
    const current = await read()
    const sentPlan = current?.planSlug ?? planSlug
    const sentEnd = current?.currentPeriodEnd ?? expiresAt
    await this.assignPlanInRoles(brandId, sentPlan, sentEnd)

    const after = await read()
    const samePeriod =
      new Date(after?.currentPeriodEnd ?? 0).getTime() === new Date(sentEnd ?? 0).getTime()
    if (after && (after.planSlug !== sentPlan || !samePeriod)) {
      await this.assignPlanInRoles(brandId, after.planSlug, after.currentPeriodEnd)
    }
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

/** The invoiced line of a token package: only the paid tokens, the bonus is not invoiced. */
function tokenPackageInvoiceDescription(payment: Payment): string {
  return `Paquete de ${Number(payment.metadata?.tokenPackage?.purchasedTokens)} tokens ROAX`
}

function tokenAmountInvoiceDescription(payment: Payment): string {
  return `Compra de ${Number(payment.metadata?.tokenAmount?.purchasedTokens)} tokens ROAX`
}
