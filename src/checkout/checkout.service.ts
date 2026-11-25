/**
 * R6: CheckoutService keeps the intake, wallet and external payment paths, their completion,
 * reconciliation and role assignment together because immediate wallet settlements and deferred
 * external webhooks share the same completion state and in-flight maps. Pricing, the subscription
 * it applies, the invoice and DIAN send, and the provider's confirmed amount live in their own files.
 */
import { HttpStatus, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { DataSource, EntityManager, Raw, Repository } from 'typeorm'

import { WalletService } from '../wallet/wallet.service'
import { InvoiceService } from '../invoice/invoice.service'
import { SubscriptionService } from '../subscription/subscription.service'
import { invalidBuyerException } from '../subscription/invalid-buyer-exception'
import { ConfioSubscriptionInputError } from '../provider/confio/confio-subscription-error'
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
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { Wallet } from '../wallet/entities/wallet.entity'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'

import { ClientRolesService } from '../client/client-roles.service'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientAuthService } from '../client/client-auth.service'
import { EnterprisePricingService } from '../subscription/enterprise-pricing.service'
import { ProviderConfigService } from '../provider/provider-config.service'
import { WebhookService } from '../webhook/webhook.service'
import { RequestException } from '../shared/exception/request.exception'
import { positiveIntEnv } from '../shared/env/positive-int-env'
import { escapeLogValue } from '../shared/logger/log-value'
import { ConfioApiError } from '../provider/confio/confio-api-error'
import {
  buildIdempotencyFingerprint,
  createRetryExpiredException,
  handleConcurrentIdempotentCheckout,
  InFlightCheckoutsMap,
  isRetryWindowOpen,
  isUniqueConstraintViolation,
  paymentBirth,
  resolveExistingIdempotentPayment,
} from './checkout-idempotency'
import { checkoutExpiryHours } from './checkout-expiry'
import { BuyerLookupFailure, resolveCheckoutBuyer } from './checkout-buyer'
import {
  hasWalletPaymentDebit,
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
import {
  normalizeRequest as normalizeCheckoutRequest,
  resolveAmountAndCurrency as resolveCheckoutPricing,
  ResolvedPricing,
} from './checkout-pricing'
import { createOrRenewSubscription as applyPlanPurchase } from './checkout-subscription'
import {
  canSendToDian,
  CheckoutDianDeps,
  generateInvoice as issueCheckoutInvoice,
  sendToDianAsync,
} from './checkout-invoice'
import {
  assertProviderConfirmedAmount,
  hasAmountMismatchMark,
  isProviderNoticePayload,
} from './provider-confirmed-amount'

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
  planSlug?: string
  amount?: number
  currency?: string
  walletId?: string
  // token_package: the catalog row; price and tokens come from it, never from the body
  packageId?: string
  // token_amount: the token count chosen by the brand; priced in Payments at TOKEN_PRICE_USD
  tokens?: number
  successUrl?: string
  cancelUrl?: string
  // Required by ConfioPagos (email and E.164 phoneNumber).
  buyer?: { firstName?: string; lastName?: string; email?: string; phoneNumber?: string }
  idempotencyKey?: string
  /** Set only by the renewal cron (stripped by the HTTP controller) to allow legacy pricing fallback without relaxing provider, tax, or wallet checks. */
  renewal?: boolean
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
  private readonly BILLING_PERIOD_DAYS = positiveIntEnv('BILLING_PERIOD_DAYS', 30)
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
    // Optional: only a Confio checkout without a usable buyer needs it, and fails closed (503) without.
    @Optional() private clientAuth?: ClientAuthService,
  ) {}

  /** Late registration breaks the CheckoutService <-> WebhookService circular dependency. */
  onModuleInit() {
    this.webhookService.setCheckoutService(this)
    this.log.log('CheckoutService registrado en WebhookService')
  }

  async processCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
    // Normalize once into a new object before any lookup so the cron caller's live subscription data is not mutated.
    const req = normalizeCheckoutRequest(request)
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

    const tokenPackage =
      req.purpose === 'token_package' ? await this.prepareTokenPackage(req) : undefined
    const tokenAmount =
      req.purpose === 'token_amount' ? await this.prepareTokenAmount(req) : undefined
    const tokenCheckout = tokenPackage ?? tokenAmount
    const { amount, currency, country } =
      tokenCheckout ?? (await this.resolveAmountAndCurrency(req))
    const rate = tokenCheckout?.rate

    // Gate the provider against the same country that determined the catalog price, not the billing profile fallback.
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

    // Tax uses the country that set the catalog price; the billing profile covers only checkouts without a country-catalog price.
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
      // Persist the resolved tax country in metadata so deferred external payment completion invoices against the same country.
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

    this.eventBus.publishPaymentCompleted({
      brandId: req.brandId,
      paymentId: payment.id,
      amount: String(subtotal + taxAmount),
      currency,
      purpose: req.purpose,
      planSlug: req.planSlug,
    })

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

  private async processExternalPayment(
    payment: Payment,
    req: CheckoutRequest,
    totalAmount: number,
    currency: string,
  ): Promise<CheckoutResult> {
    try {
      const provider = this.providerFactory.getProvider(req.provider)
      const buyer = await resolveCheckoutBuyer(req, this.clientAuth, this.clientPlatform)
      const checkout = await provider.createCheckout({
        amount: totalAmount,
        currency,
        brandId: req.brandId,
        userId: req.userId,
        purpose: req.purpose,
        purposeId: req.planSlug,
        successUrl: req.successUrl,
        cancelUrl: req.cancelUrl,
        metadata: { paymentId: payment.id, buyer },
      })

      const result: CheckoutResult = {
        paymentId: payment.id,
        status: 'pending',
        checkoutUrl: checkout.checkoutUrl,
      }

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
      const invalidBuyer = error instanceof ConfioSubscriptionInputError
      payment.status = PaymentStatus.FAILED
      // The input error's message holds the buyer's contact; its code and field say enough.
      payment.failureReason = invalidBuyer ? `${error.code} ${error.field}` : error.message
      await this.paymentRepo.save(payment)

      if (invalidBuyer) throw invalidBuyerException(error.field)
      if (error instanceof BuyerLookupFailure) throw error.toException()
      throw new RequestException({
        code: 'PROVIDER_ERROR',
        message: `No se pudo iniciar el pago con ${req.provider}`,
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

  /** @returns true only if this call left the payment `completed`. */
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
        hasAmountMismatchMark(payment)
      ) {
        return false
      }

      const previousStatus = payment.status
      const previousMetadata = payment.metadata
      const isNotice = Boolean(expectedProvider) || isProviderNoticePayload(providerData)
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
    const amountConfirmed = await assertProviderConfirmedAmount(
      { paymentRepo: this.paymentRepo, dataSource: this.dataSource, logger: this.log },
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

    // Use the tax country stored on the payment at checkout; fall back to the billing profile when absent.
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

    sendToDianAsync(this.dianDeps, invoice.id, payment.currency)

    await this.auditService.log(
      'system',
      'external_payment_completed',
      'payment',
      payment.id,
      { provider: payment.provider, amount: totalAmount },
      `Pago externo completado via ${payment.provider}`,
    )

    this.eventBus.publishPaymentCompleted({
      brandId: payment.brandId,
      paymentId: payment.id,
      amount: String(payment.amount),
      currency: payment.currency,
      purpose: payment.purpose,
      planSlug: payment.purposeId,
    })

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
      canSendToDian: (invoiceId, currency) => canSendToDian(this.dianDeps, invoiceId, currency),
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
    if (current?.status === PaymentStatus.FAILED || hasAmountMismatchMark(current)) {
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
    if (payment.status === PaymentStatus.FAILED || hasAmountMismatchMark(payment)) {
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

  private resolveAmountAndCurrency(req: CheckoutRequest): Promise<ResolvedPricing> {
    return resolveCheckoutPricing(req, {
      enterprisePricing: this.enterprisePricing,
      clientPlatform: this.clientPlatform,
      clientRoles: this.clientRoles,
      logger: this.log,
    })
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

  private createOrRenewSubscription(
    req: CheckoutRequest,
    payment: Payment,
    manager?: EntityManager,
  ): Promise<{ subscription: Subscription; extended: boolean }> {
    return applyPlanPurchase(
      req,
      payment,
      {
        subscriptionRepo: this.subscriptionRepo,
        subscriptionEventRepo: this.subscriptionEventRepo,
        paymentRepo: this.paymentRepo,
        billingPeriodDays: this.BILLING_PERIOD_DAYS,
      },
      manager,
    )
  }

  private generateInvoice(
    payment: Payment,
    req: any,
    subtotal: number,
    taxAmount: number,
    currency: string,
    tax: any,
    extendedUntil?: Date,
  ): Promise<any> {
    const deps = {
      billingProfileRepo: this.billingProfileRepo,
      invoiceService: this.invoiceService,
    }
    return issueCheckoutInvoice(
      deps,
      payment,
      req,
      subtotal,
      taxAmount,
      currency,
      tax,
      extendedUntil,
    )
  }

  private get dianDeps(): CheckoutDianDeps {
    return { dianService: this.dianService, logger: this.log }
  }

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

  /** Country from the brand's billing profile (for tax and provider fallback), distinct from the registration country in `backend-platform`. */
  private async getBillingCountry(brandId: string): Promise<string> {
    const profile = await this.billingProfileRepo.findOne({
      where: { brandId },
    })
    return profile?.country || 'CO' // Default Colombia
  }
}
