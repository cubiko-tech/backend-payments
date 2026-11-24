// R6: one adapter of one provider API: payments, plans, subscriptions and webhooks share its client.
import { Injectable } from '@nestjs/common'
import { timingSafeEqual } from 'crypto'
import {
  PaymentProvider,
  ProviderPaymentNotFoundError,
  CreateCheckoutParams,
  CheckoutResult,
  PaymentStatusResult,
  RefundResult,
  CreateSubscriptionParams,
  SaveMethodParams,
} from '../provider.interface'
import { isProductionEnv } from '../../shared/env/is-production'
import { logger } from '../../shared/logger/logger'
import { ConfioApiError } from './confio-api-error'
import { ConfioSubscriptionInputError } from './confio-subscription-error'
import { assertConfioBuyer } from './confio-buyer'
import {
  ConfioSubscription,
  ConfioSubscriptionPlan,
  ConfioSubscriptionResult,
  CreateConfioPlanParams,
  CreateConfioSubscriptionParams,
  ListConfioPlansResponse,
} from './confio.types'

/**
 * ConfioPagos adapter: one-shot payment links plus recurring plans and subscriptions.
 *
 * A one-shot payment returns a link; the buyer pays and ConfioPagos confirms by webhook,
 * authenticated with the same `CONFIO_ACCESS_TOKEN` as a Bearer header.
 *
 * Creating a subscription charges nothing: it returns `PENDING_ACCEPTANCE` plus a hosted
 * `acceptanceUrl` where the buyer registers a card; ConfioPagos then bills each period itself.
 *
 * The `acceptanceUrl` is a bearer link (whoever holds it registers a card against the
 * subscription): it is never logged nor persisted, and the mapper strips it from `raw`.
 *
 * `CONFIO_API_BASE_URL` already ends in `/v1`, so paths go without it: a repeated `/v1` gets a
 * plain-text 404 that looks like a missing endpoint.
 *
 * Contract reference: roax-ads-back/internal/payment/.../confiopagos_client.go
 */
// Re-exported from its own module because `confio-buyer.ts` needs it and this file imports that one:
// defining it here is a CommonJS cycle that leaves the class `undefined` at load time.
export {
  CONFIO_SUBSCRIPTION_INPUT_ERROR,
  ConfioSubscriptionInputError,
} from './confio-subscription-error'
export type { ConfioSubscriptionInputErrorCode } from './confio-subscription-error'

@Injectable()
export class ConfioProvider implements PaymentProvider {
  readonly name = 'confio'

  private readonly baseUrl: string
  private readonly storeId: string | null
  private readonly accessToken: string | null

  constructor() {
    this.baseUrl =
      process.env.CONFIO_API_BASE_URL ||
      (isProductionEnv() ? 'https://api.confiopagos.com/v1' : 'https://api.dev.confiopagos.com/v1')

    const storeId = process.env.CONFIO_STORE_ID
    const token = process.env.CONFIO_ACCESS_TOKEN
    if (storeId && token && token !== 'CHANGEME') {
      this.storeId = storeId
      this.accessToken = token
      logger.log('info', `ConfioProvider: inicializado (${this.baseUrl})`)
    } else {
      this.storeId = null
      this.accessToken = null
      logger.log('warn', 'ConfioProvider: CONFIO_STORE_ID/CONFIO_ACCESS_TOKEN no configurados')
    }
  }

  private ensureConfigured() {
    if (!this.storeId || !this.accessToken) {
      throw new Error(
        'ConfioPagos no configurado. Configure CONFIO_STORE_ID y CONFIO_ACCESS_TOKEN en .env',
      )
    }
  }

  private async confioFetch(path: string, options: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(30000),
    })

    const text = await response.text()

    // Error messages carry the HTTP status only: callers log them, and the body can hold buyer data.
    if (response.status === 404) {
      throw new ProviderPaymentNotFoundError('ConfioPagos error 404')
    }

    // `any` because callers read arbitrary body fields.
    let body: any
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      // Some ConfioPagos errors are plain text: report their status, not a SyntaxError.
      throw new ConfioApiError(
        `ConfioPagos respondió ${response.status} con un cuerpo que no es JSON`,
        response.status,
      )
    }

    if (!response.ok) {
      const code = body?.code == null ? undefined : String(body.code)
      throw new ConfioApiError(`ConfioPagos error ${response.status}`, response.status, code)
    }
    return body
  }

  /** Returns the payment link as `checkoutUrl` and the resource `name` as `providerPaymentId`. */
  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutResult> {
    this.ensureConfigured()

    const buyer = this.resolveBuyer(params)
    const description =
      params.purpose === 'plan_purchase'
        ? `Suscripción plan ${params.purposeId || ''}`.trim()
        : params.purpose === 'wallet_recharge'
          ? 'Recarga de wallet Cubiko'
          : 'Pago de servicio Cubiko'

    const body = {
      amountCents: Math.round(params.amount * 100),
      currencyCode: params.currency,
      title: 'Cubiko',
      description,
      buyer,
      // Our paymentId, so the webhook can resolve the payment.
      correlationId: params.metadata?.paymentId || '',
      paymentType: 'SERVICE',
      redirectUri: params.successUrl || undefined,
      metadata: this.stringifyMetadata(params.metadata),
    }

    const resp = await this.confioFetch(`/stores/${this.storeId}/payments`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    logger.log('info', `ConfioProvider: pago creado ${resp.name}`)

    return {
      providerPaymentId: resp.name,
      checkoutUrl: resp.url,
      status: 'pending',
    }
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    this.ensureConfigured()

    // Accepts either the full resource name (`stores/{id}/payments/{ulid}`) or a bare id.
    const path = providerPaymentId.startsWith('stores/')
      ? `/${providerPaymentId}`
      : `/stores/${this.storeId}/payments/${providerPaymentId}`
    const resp = await this.confioFetch(path, { method: 'GET' })

    return {
      status: ConfioProvider.mapStatus(resp.status),
      paidAt: resp.completedAt ? new Date(resp.completedAt) : undefined,
      metadata: {
        confioStatus: resp.status,
        paymentMethod: resp.paymentMethod,
        amountCents: resp.amountCents,
      },
    }
  }

  /** ConfioPagos exposes no refunds in this integration. */
  async refundPayment(_providerPaymentId: string, _amount?: number): Promise<RefundResult> {
    throw new Error('ConfioPagos no soporta reembolsos automáticos en esta integración')
  }

  /**
   * A created plan can never be deleted nor updated (`amountCents` and `trialPeriodDays` are frozen),
   * and the store is shared with backend-ads: every caller must list before creating
   * (`listSubscriptionPlans`).
   */
  async createSubscriptionPlan(params: CreateConfioPlanParams): Promise<ConfioSubscriptionPlan> {
    this.ensureConfigured()

    const body = {
      displayName: params.displayName,
      ...(params.description ? { description: params.description } : {}),
      amountCents: params.amountCents,
      currencyCode: params.currencyCode,
      billingCycleFrequency: params.billingCycleFrequency || 'MONTHLY',
      billingCycleInterval: params.billingCycleInterval ?? 1,
      trialPeriodDays: params.trialPeriodDays,
    }

    const resp: ConfioSubscriptionPlan = await this.confioFetch(
      `/stores/${this.storeId}/subscription-plans`,
      { method: 'POST', body: JSON.stringify(body) },
    )

    logger.log(
      'info',
      `ConfioProvider: plan de suscripción creado ${resp.name} ` +
        `(${resp.amountCents} ${resp.currencyCode}, trial ${resp.trialPeriodDays}d)`,
    )

    return resp
  }

  /**
   * Follows every page: stopping at the first one can miss an existing plan and lead to an
   * undeletable duplicate. `nextPageToken` is an empty string on the last page, not absent.
   */
  async listSubscriptionPlans(): Promise<ConfioSubscriptionPlan[]> {
    this.ensureConfigured()

    const out: ConfioSubscriptionPlan[] = []
    let pageToken: string | undefined
    // Hard cap so a repeating page token cannot loop forever.
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ pageSize: '100' })
      if (pageToken) query.set('pageToken', pageToken)

      const resp: ListConfioPlansResponse = await this.confioFetch(
        `/stores/${this.storeId}/subscription-plans?${query.toString()}`,
        { method: 'GET' },
      )

      out.push(...(resp.plans ?? []))
      if (!resp.nextPageToken) return out
      pageToken = resp.nextPageToken
    }

    logger.log('warn', 'ConfioProvider: listSubscriptionPlans cortó en el tope de 20 páginas')
    return out
  }

  /**
   * Charges nothing: returns `PENDING_ACCEPTANCE` plus an `acceptanceUrl`; once the buyer accepts it
   * moves to `TRIALING` (with `trialPeriodDays > 0`) or `ACTIVE`.
   *
   * `CreateSubscriptionParams` is accepted only to satisfy `PaymentProvider`; it lacks plan and
   * buyer, so it is rejected with `missing_buyer_or_plan`.
   *
   * Input errors are `ConfioSubscriptionInputError`, thrown before any network call; callers map
   * them by `instanceof` + `code` + `field`, never by message text.
   */
  async createSubscription(
    params: CreateConfioSubscriptionParams | CreateSubscriptionParams,
  ): Promise<ConfioSubscriptionResult> {
    this.ensureConfigured()

    if (!('planName' in params) || !params.planName || !params.buyer) {
      throw new ConfioSubscriptionInputError(
        'missing_buyer_or_plan',
        'planName/buyer',
        'el alta de ConfioPagos necesita el resource name del plan y el comprador completo',
      )
    }

    const planPath = this.assertPlanPath(params.planName)
    const buyer = assertConfioBuyer(params.buyer)

    // Checked with `!== undefined`, not truthiness: `firstChargeAmountCents: 0` means a free first
    // cycle, and dropping it makes Confio silently charge the full cycle.
    const body: Record<string, unknown> = { buyer }
    if (params.correlationId !== undefined) body.correlationId = params.correlationId
    if (params.firstChargeAmountCents !== undefined) {
      body.firstChargeAmountCents = params.firstChargeAmountCents
    }
    if (params.redirectUri !== undefined) body.redirectUri = params.redirectUri
    if (params.acceptanceExpireTime !== undefined) {
      body.acceptanceExpireTime = params.acceptanceExpireTime
    }

    const resp: ConfioSubscription = await this.confioFetch(`/${planPath}/subscriptions`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    // `acceptanceUrl` is a bearer link: log whether it came, never its value.
    logger.log(
      'info',
      `ConfioProvider: suscripción creada ${resp.name} (${resp.status}, ` +
        `link de aceptación: ${resp.acceptanceUrl ? 'sí' : 'no'})`,
    )

    return ConfioProvider.toSubscriptionResult(resp)
  }

  /**
   * Not part of `PaymentProvider`: use the concrete `ConfioProvider`, not
   * `ProviderFactory.getProvider()`.
   *
   * Requires the full resource name: a bare id would also need the plan id, and guessing it yields a
   * 404 that reads as a missing subscription.
   */
  async getSubscription(name: string): Promise<ConfioSubscriptionResult> {
    this.ensureConfigured()

    const resp: ConfioSubscription = await this.confioFetch(
      `/${ConfioProvider.toSubscriptionPath(name)}`,
      { method: 'GET' },
    )

    return ConfioProvider.toSubscriptionResult(resp)
  }

  /**
   * Plans are per environment: a dev or foreign-store plan id gets a silent 404 that reads as a
   * missing endpoint, so it is rejected here naming the expected store.
   */
  private assertPlanPath(planName: string): string {
    return this.assertStorePath(planName, 'planName')
  }

  /**
   * Checks our store and the exact shape. The stored `name` can arrive unvalidated (e.g. from the
   * `POST /subscription` body), and interpolated raw it would aim a request carrying our Bearer at
   * another store's subscription (the store is shared with backend-ads) or, through `..` segments
   * that `fetch` normalizes, at any ConfioPagos endpoint. The closed charset also blocks log line
   * injection.
   */
  private assertSubscriptionPath(name: string): string {
    const path = this.assertStorePath(name, 'name')
    if (!ConfioProvider.SUBSCRIPTION_PATH.test(path)) {
      throw new ConfioSubscriptionInputError(
        'invalid_subscription_name',
        'name',
        `el resource name "${name}" no tiene la forma de una suscripción de ConfioPagos`,
      )
    }
    return path
  }

  /** Rejects any resource outside the configured store. */
  private assertStorePath(name: string, field: 'planName' | 'name'): string {
    const path = ConfioProvider.toSubscriptionPath(name)
    if (!path.startsWith(`stores/${this.storeId}/`)) {
      throw new ConfioSubscriptionInputError(
        'plan_store_mismatch',
        field,
        `el recurso ${name} no pertenece al store configurado (${this.storeId})`,
      )
    }
    return path
  }

  /**
   * Closed charset on purpose: ConfioPagos ids are ULIDs, so a `..`, `#` or newline is an attempt
   * to escape the path, not an id.
   */
  private static readonly SUBSCRIPTION_PATH =
    /^stores\/[A-Za-z0-9_-]+\/subscription-plans\/[A-Za-z0-9_-]+\/subscriptions\/[A-Za-z0-9_-]+$/

  /**
   * Some ConfioPagos names carry an `organizations/...` prefix, so everything before `stores/` is
   * cut. A bare id is rejected: no path can be built from it.
   */
  private static toSubscriptionPath(name: string): string {
    // `name` can come from untyped jsonb: a non-string is rejected here, not as an opaque TypeError.
    const raw = typeof name === 'string' ? name : ''
    const at = raw.indexOf('stores/')
    if (at < 0) {
      throw new ConfioSubscriptionInputError(
        'invalid_subscription_name',
        'name',
        `se esperaba un resource name que contenga "stores/", llegó "${name}"`,
      )
    }
    return raw.slice(at)
  }

  /**
   * `acceptanceUrl` is stripped from `raw` and exposed only at top level, so a downstream
   * `metadata: result.raw` can never persist the bearer link.
   */
  private static toSubscriptionResult(raw: ConfioSubscription): ConfioSubscriptionResult {
    const { acceptanceUrl, ...rest } = raw || ({} as ConfioSubscription)

    return {
      providerSubscriptionId: rest.name,
      status: rest.status,
      acceptanceUrl,
      acceptanceExpireTime: rest.acceptanceExpireTime
        ? new Date(rest.acceptanceExpireTime)
        : undefined,
      // Undefined in PENDING_ACCEPTANCE (no open period yet), although `SubscriptionResult` types them
      // as required.
      currentPeriodStart: rest.currentPeriodStart ? new Date(rest.currentPeriodStart) : undefined,
      currentPeriodEnd: rest.currentPeriodEnd ? new Date(rest.currentPeriodEnd) : undefined,
      nextBillingTime: rest.nextBillingTime ? new Date(rest.nextBillingTime) : undefined,
      correlationId: rest.correlationId,
      raw: rest,
    }
  }

  /**
   * Works even in `PENDING_ACCEPTANCE`. The response body is empty, so HTTP 200 is the confirmation
   * and this returns `void`. Idempotent: cancelling twice also returns 200, so retries are safe.
   *
   * ConfioPagos requires `reason`; a missing one is a `ConfioSubscriptionInputError` thrown before
   * any network call. `reason` is free user text and is never logged.
   *
   * The whole path is validated (`assertSubscriptionPath`) before interpolation, so a caller-chosen
   * `name` cannot aim this Bearer-authenticated POST at another store or endpoint.
   */
  async cancelSubscription(providerSubscriptionId: string, reason?: string): Promise<void> {
    this.ensureConfigured()

    // Sending without `reason` would be a ConfioPagos 4xx disguised as a channel failure.
    if (!String(reason || '').trim()) {
      throw new ConfioSubscriptionInputError(
        'missing_cancel_reason',
        'reason',
        'ConfioPagos exige un motivo para cancelar la suscripción',
      )
    }

    const path = this.assertSubscriptionPath(providerSubscriptionId)

    await this.confioFetch(`/${path}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    })

    logger.log('info', `ConfioProvider: suscripción cancelada ${path}`)
  }

  async savePaymentMethod(_params: SaveMethodParams): Promise<{ setupUrl: string }> {
    throw new Error('ConfioPagos no soporta guardar métodos de pago')
  }

  async removePaymentMethod(_providerMethodId: string): Promise<void> {
    throw new Error('ConfioPagos no soporta métodos de pago')
  }

  /**
   * ConfioPagos has no separate signing secret: `signature` is the received Bearer token, compared
   * in constant time against our access token.
   */
  validateWebhookSignature(_payload: Buffer, signature: string): boolean {
    if (!this.accessToken) {
      logger.log('error', 'ConfioProvider: access token not configured — webhook rejected')
      return false
    }

    const received = Buffer.from(signature || '')
    const expected = Buffer.from(this.accessToken)
    if (received.length !== expected.length) return false
    return timingSafeEqual(received, expected)
  }

  static mapStatus(confioStatus: string): PaymentStatusResult['status'] {
    switch (confioStatus) {
      case 'FUNDED':
      case 'DELIVERING':
      case 'APPROVED':
        return 'completed'
      case 'PAYMENT_IN_PROGRESS':
      case 'UNDER_REVIEW':
      case 'DISPUTED':
        return 'processing'
      case 'REFUNDED':
        return 'refunded'
      case 'AWAITING_PAYMENT':
        return 'pending'
      case 'EXPIRED':
      case 'CANCELED':
      case 'FAILED':
        return 'failed'
      default:
        return 'pending'
    }
  }

  static isCompleted(confioStatus: string): boolean {
    return confioStatus === 'FUNDED' || confioStatus === 'DELIVERING' || confioStatus === 'APPROVED'
  }

  /**
   * ConfioPagos requires a buyer with an email and an E.164 phone, taken from `metadata.buyer`.
   * Without a usable one `assertConfioBuyer` rejects with `invalid_buyer` before the request
   * leaves, as a subscription does: no contact is ever made up.
   */
  private resolveBuyer(params: CreateCheckoutParams) {
    const b = params.metadata?.buyer || {}
    return assertConfioBuyer({
      firstName: b.firstName || 'Cliente',
      lastName: b.lastName || 'Cubiko',
      email: b.email,
      phoneNumber: ConfioProvider.normalizeColombianPhone(b.phoneNumber),
    })
  }

  /** ConfioPagos requires metadata as map<string,string>. */
  private stringifyMetadata(metadata?: Record<string, any>): Record<string, string> | undefined {
    if (!metadata) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(metadata)) {
      if (k === 'buyer') continue
      if (v === undefined || v === null) continue
      out[k] = typeof v === 'string' ? v : JSON.stringify(v)
    }
    return Object.keys(out).length ? out : undefined
  }

  /**
   * Turns a Colombian phone into E.164 (+57XXXXXXXXXX). Anything else comes back trimmed and
   * unchanged so `assertConfioBuyer` judges it: a missing or invalid phone is rejected.
   *
   * Not for subscriptions: only `resolveBuyer` uses it, for one-shot payment links, because it
   * assumes Colombia for a local number; `confio-buyer.ts` builds the subscription buyer.
   */
  static normalizeColombianPhone(raw?: string): string {
    const original = (raw || '').trim()
    let phone = original
    if (phone.startsWith('+57') && phone.length >= 12) return phone
    phone = phone.replace(/^\+/, '')
    if (phone.length === 10 && phone[0] === '3') return '+57' + phone
    if (phone.length === 12 && phone.startsWith('57')) return '+' + phone
    return original
  }
}
