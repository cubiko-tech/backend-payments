import { Injectable } from '@nestjs/common'
import { timingSafeEqual } from 'crypto'
import {
  PaymentProvider,
  CreateCheckoutParams,
  CheckoutResult,
  PaymentStatusResult,
  RefundResult,
  CreateSubscriptionParams,
  SaveMethodParams,
} from '../provider.interface'
import { logger } from '../../shared/logger/logger'
import {
  ConfioSubscription,
  ConfioSubscriptionPlan,
  ConfioSubscriptionResult,
  ConfioBuyer,
  CreateConfioPlanParams,
  CreateConfioSubscriptionParams,
  ListConfioPlansResponse,
} from './confio.types'

/**
 * ConfioPagos — pasarela de pagos colombiana (links de pago one-shot).
 *
 * Flujo: se crea un pago en `POST /stores/{storeId}/payments` que devuelve una
 * `url` (link de pago). El usuario paga y ConfioPagos confirma vía webhook
 * (validado por el mismo `CONFIO_ACCESS_TOKEN` en el header Authorization).
 *
 * No tiene checkout session como Stripe; es un link + confirmación asíncrona,
 * similar a Dropi pero con URL de pago.
 *
 * Para el cobro recurrente sí tiene API propia de planes y suscripciones
 * (`/stores/{store}/subscription-plans…`): ConfioPagos cobra cada período y
 * avisa por webhook. Acá viven los dos métodos de **planes**
 * (`createSubscriptionPlan`, `listSubscriptionPlans`) y los dos de
 * **suscripciones** (`createSubscription`, `getSubscription`).
 *
 * Flujo real del alta: **no cobra**. Devuelve la suscripción en
 * `PENDING_ACCEPTANCE` más un `acceptanceUrl` hospedado por ConfioPagos — el
 * «único link de pago inicial» del criterio 1 de la épica 002. El comprador
 * acepta ahí y registra su tarjeta; recién entonces pasa a `TRIALING` (con los
 * 15 días de trial del plan) o a `ACTIVE`, y a partir de ahí ConfioPagos cobra
 * cada período por su cuenta.
 *
 * ⚠️ El `acceptanceUrl` es un **link portador**: quien lo tenga registra una
 * tarjeta contra esta suscripción. No se loguea, no se persiste y por eso el
 * mapeador lo saca del `raw` que devuelve.
 *
 * ⚠️ `getSubscription` **no forma parte de `PaymentProvider`**: se consume con
 * el tipo concreto `ConfioProvider`, no por `ProviderFactory.getProvider()`.
 *
 * 🔧 Deuda conocida: `cancelSubscription` sigue siendo un no-op y ahora miente
 * más que antes, porque el endpoint existe (`POST …/{sub}/cancel`, con `reason`
 * obligatorio). Fuera del alcance de esta tarea: lo cubre
 * `cancelacion-de-la-renovacion`.
 *
 * ⚠️ `CONFIO_API_BASE_URL` **ya termina en `/v1`** y `confioFetch` concatena, así
 * que los paths van SIN ese prefijo. Con `/v1` repetido ConfioPagos responde un
 * 404 en texto plano que parece «ese endpoint no existe».
 *
 * Referencia de contrato: roax-ads-back/internal/payment/.../confiopagos_client.go
 */
/** Prefijo de todo mensaje de `ConfioSubscriptionInputError`. */
export const CONFIO_SUBSCRIPTION_INPUT_ERROR = 'ConfioSubscription rechazada'

/** Códigos de rechazo local, ANTES de tocar la red. */
export type ConfioSubscriptionInputErrorCode =
  | 'missing_buyer_or_plan'
  | 'invalid_buyer'
  | 'plan_store_mismatch'
  | 'invalid_subscription_name'

/**
 * Rechazo de entrada del cliente de suscripciones: la petición nunca salió.
 *
 * **Este error es contrato con el alta** (`alta-crea-suscripcion-en-confiopagos`),
 * que necesita rechazar «con un código propio, no con un 422 opaco de Confío».
 * Se mapea por `instanceof` + `code` + `field`, NUNCA por el texto del mensaje.
 * Si cambiás `code` o `field`, actualizá ese mapeo.
 */
export class ConfioSubscriptionInputError extends Error {
  constructor(
    readonly code: ConfioSubscriptionInputErrorCode,
    readonly field: string,
    detail: string,
  ) {
    super(`${CONFIO_SUBSCRIPTION_INPUT_ERROR} [${code}] ${field}: ${detail}`)
    this.name = 'ConfioSubscriptionInputError'
  }
}

@Injectable()
export class ConfioProvider implements PaymentProvider {
  readonly name = 'confio'

  private readonly baseUrl: string
  private readonly storeId: string | null
  private readonly accessToken: string | null

  constructor() {
    this.baseUrl =
      process.env.CONFIO_API_BASE_URL ||
      (process.env.GO_ENV === 'production' || process.env.NODE_ENV === 'production'
        ? 'https://api.confiopagos.com/v1'
        : 'https://api.dev.confiopagos.com/v1')

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
      throw new Error('ConfioPagos no configurado. Configure CONFIO_STORE_ID y CONFIO_ACCESS_TOKEN en .env')
    }
  }

  private async confioFetch(path: string, options: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...options.headers,
      },
      signal: AbortSignal.timeout(30000),
    })

    const text = await response.text()
    const body = text ? JSON.parse(text) : {}
    if (!response.ok) {
      throw new Error(`ConfioPagos error ${response.status}: ${JSON.stringify(body)}`)
    }
    return body
  }

  /**
   * Crear un pago en ConfioPagos. Devuelve el link de pago (`url`) y el
   * nombre del recurso (`name`) como `providerPaymentId`.
   */
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
      // correlationId = nuestro paymentId, para resolver el pago en el webhook.
      correlationId: params.metadata?.paymentId || '',
      paymentType: 'SERVICE',
      redirectUri: params.successUrl || undefined,
      metadata: this.stringifyMetadata(params.metadata),
    }

    const resp = await this.confioFetch(`/stores/${this.storeId}/payments`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    logger.log('info', `ConfioProvider: pago creado ${resp.name} (${resp.url})`)

    return {
      providerPaymentId: resp.name,
      checkoutUrl: resp.url,
      status: 'pending',
    }
  }

  async getPaymentStatus(providerPaymentId: string): Promise<PaymentStatusResult> {
    this.ensureConfigured()

    // `providerPaymentId` suele ser el resource name completo (`stores/{id}/payments/{ulid}`);
    // si ya viene así, se usa relativo a la base; si no, se compone la ruta.
    const path = providerPaymentId.startsWith('stores/')
      ? `/${providerPaymentId}`
      : `/stores/${this.storeId}/payments/${providerPaymentId}`
    const resp = await this.confioFetch(path, { method: 'GET' })

    return {
      status: ConfioProvider.mapStatus(resp.status),
      paidAt: resp.completedAt ? new Date(resp.completedAt) : undefined,
      metadata: { confioStatus: resp.status, paymentMethod: resp.paymentMethod },
    }
  }

  /**
   * ConfioPagos no expone reembolsos en este flujo de integración.
   */
  async refundPayment(_providerPaymentId: string, _amount?: number): Promise<RefundResult> {
    throw new Error('ConfioPagos no soporta reembolsos automáticos en esta integración')
  }

  /**
   * Crear un plan recurrente en ConfioPagos.
   *
   * ⚠️ **Un plan creado NO se puede borrar** y ConfioPagos no expone update:
   * `amountCents` y `trialPeriodDays` quedan congelados. Además el store está
   * COMPARTIDO con backend-ads, así que un plan de más ensucia el store de otro
   * servicio. Todo llamador debe **listar antes de crear** (`listSubscriptionPlans`).
   *
   * Por eso hoy este método NO tiene llamador: el alta real de los planes de
   * `dropi-roax` es una decisión operativa pendiente (ver HUMAN_ACTIONS.md sobre
   * quién es dueño de las suscripciones en ese store), no algo que dispare el
   * arranque del servicio.
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
   * Listar todos los planes del store, siguiendo la paginación.
   *
   * El listado pagina: quedarse en la primera página puede "no encontrar" un
   * plan que sí existe y llevar a crear un duplicado imborrable. `nextPageToken`
   * llega como string VACÍO en la última página, no ausente.
   */
  async listSubscriptionPlans(): Promise<ConfioSubscriptionPlan[]> {
    this.ensureConfigured()

    const out: ConfioSubscriptionPlan[] = []
    let pageToken: string | undefined
    // Tope duro: 20 páginas × 100 = 2.000 planes. Corta un token que se repita
    // en vez de girar para siempre.
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
   * Alta de suscripción — `POST …/subscription-plans/{plan}/subscriptions`.
   *
   * **No cobra nada.** Devuelve la suscripción en `PENDING_ACCEPTANCE` más un
   * `acceptanceUrl` hospedado por ConfioPagos: ése es el «único link inicial»
   * del criterio 1 de la épica. El comprador acepta ahí, registra su tarjeta y
   * la suscripción pasa a `TRIALING` (con `trialPeriodDays > 0`) o a `ACTIVE`.
   *
   * El parámetro acepta la unión con `CreateSubscriptionParams` sólo para
   * satisfacer el contrato de `PaymentProvider`: esa forma no trae ni el plan de
   * ConfioPagos ni el comprador, así que se rechaza con `missing_buyer_or_plan`.
   * No es un camino soportado.
   *
   * Rechaza ANTES de tocar la red con `ConfioSubscriptionInputError` —
   * **contrato con el alta** (`alta-crea-suscripcion-en-confiopagos`), que mapea
   * por `instanceof` + `code` + `field`, nunca por el texto del mensaje.
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
    const buyer = ConfioProvider.assertSubscriptionBuyer(params.buyer)

    // Body armado campo por campo con `!== undefined`, NO por truthiness como
    // el `...(params.description ? … : {})` de createSubscriptionPlan: acá el 0
    // de `firstChargeAmountCents` es válido (`minimum: 0` en el spec) y
    // significa PRIMER CICLO GRATIS. Tragárselo haría que Confío cobre el ciclo
    // entero, en silencio. Lo mismo con un `correlationId` vacío.
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

    // El `acceptanceUrl` es un link PORTADOR (quien lo tenga registra una
    // tarjeta): se loguea si vino, jamás su valor.
    logger.log(
      'info',
      `ConfioProvider: suscripción creada ${resp.name} (${resp.status}, ` +
        `link de aceptación: ${resp.acceptanceUrl ? 'sí' : 'no'})`,
    )

    return ConfioProvider.toSubscriptionResult(resp)
  }

  /**
   * Consultar una suscripción por su resource name completo.
   *
   * ⚠️ **No está en `PaymentProvider`**: se consume con el tipo concreto
   * `ConfioProvider`, no por `ProviderFactory.getProvider()`, que devuelve la
   * interfaz y no ve este método.
   *
   * A diferencia de `getPaymentStatus`, no compone la ruta desde `this.storeId`
   * cuando el nombre viene suelto: haría falta también el id del plan, y
   * adivinarlo produce un 404 que se lee como «esa suscripción no existe».
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
   * Valida que el `planName` sea un resource name de NUESTRO store y devuelve
   * la ruta relativa a la base.
   *
   * Los planes son POR AMBIENTE: un identificador de dev usado en producción (o
   * de otra tienda) responde un 404 mudo que se lee como «el endpoint no
   * existe». Mejor cortar acá y decir cuál era el store esperado.
   */
  private assertPlanPath(planName: string): string {
    const path = ConfioProvider.toSubscriptionPath(planName)
    if (!path.startsWith(`stores/${this.storeId}/`)) {
      throw new ConfioSubscriptionInputError(
        'plan_store_mismatch',
        'planName',
        `el plan ${planName} no pertenece al store configurado (${this.storeId})`,
      )
    }
    return path
  }

  /**
   * Normaliza un resource name a ruta relativa a la base (que ya trae `/v1`).
   *
   * ConfioPagos devuelve algunos names prefijados con `organizations/…` (se ve
   * en el ejemplo de payload de webhook), así que se recorta todo lo anterior a
   * `stores/`. Un id suelto se rechaza: de ahí no se puede componer la ruta.
   */
  private static toSubscriptionPath(name: string): string {
    const at = (name || '').indexOf('stores/')
    if (at < 0) {
      throw new ConfioSubscriptionInputError(
        'invalid_subscription_name',
        'name',
        `se esperaba un resource name que contenga "stores/", llegó "${name}"`,
      )
    }
    return name.slice(at)
  }

  /**
   * Valida el comprador contra las reglas del spec (`CreateSubscriptionRequest`)
   * y devuelve la copia normalizada que se manda.
   *
   * ⚠️ **No usa `normalizeColombianPhone` como está**: ese helper sustituye en
   * silencio un teléfono inválido por el `+573215786325` de la documentación.
   * En un link one-shot es cosmético; pegado a un cobro RECURRENTE es un
   * contacto falso que se repite todos los meses, y además rompe al comprador
   * del plan en USD. Acá un E.164 válido pasa, un número local colombiano se
   * normaliza, y cualquier otra cosa se RECHAZA.
   */
  private static assertSubscriptionBuyer(raw: ConfioBuyer): ConfioBuyer {
    const buyer: ConfioBuyer = {
      email: (raw?.email || '').trim(),
      phoneNumber: (raw?.phoneNumber || '').trim(),
      firstName: (raw?.firstName || '').trim(),
      lastName: (raw?.lastName || '').trim(),
    }

    if (!buyer.email || !buyer.email.includes('@')) {
      throw new ConfioSubscriptionInputError('invalid_buyer', 'buyer.email', 'email vacío o sin "@"')
    }
    for (const field of ['firstName', 'lastName'] as const) {
      const value = buyer[field]
      if (value.length < 3 || value.length > 64) {
        throw new ConfioSubscriptionInputError(
          'invalid_buyer',
          `buyer.${field}`,
          `ConfioPagos exige de 3 a 64 caracteres, llegó ${value.length}`,
        )
      }
    }

    buyer.phoneNumber = ConfioProvider.toE164(buyer.phoneNumber)
    return buyer
  }

  /** E.164 estricto, o el número local colombiano ya normalizado. Si no, rechaza. */
  private static toE164(phone: string): string {
    if (/^\+[1-9]\d{7,14}$/.test(phone)) return phone

    // Sólo para números locales: si `normalizeColombianPhone` tuvo que caer a su
    // fallback, el teléfono era inválido y NO se inventa uno.
    const normalized = ConfioProvider.normalizeColombianPhone(phone)
    if (/^\+[1-9]\d{7,14}$/.test(normalized) && normalized !== '+573215786325') return normalized

    throw new ConfioSubscriptionInputError(
      'invalid_buyer',
      'buyer.phoneNumber',
      `se esperaba E.164 (+<país><número>), llegó "${phone}"`,
    )
  }

  /**
   * Mapeador único del envelope de suscripción, para el alta y para la consulta.
   *
   * El `acceptanceUrl` se **saca** del objeto que queda en `raw` y se expone en
   * un solo campo de primer nivel: así un `metadata: result.raw` aguas abajo no
   * puede persistir un link portador.
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
      // En PENDING_ACCEPTANCE todavía no hay período abierto: quedan undefined
      // pese a estar tipados obligatorios en `SubscriptionResult` (ver el tipo).
      currentPeriodStart: rest.currentPeriodStart ? new Date(rest.currentPeriodStart) : undefined,
      currentPeriodEnd: rest.currentPeriodEnd ? new Date(rest.currentPeriodEnd) : undefined,
      nextBillingTime: rest.nextBillingTime ? new Date(rest.nextBillingTime) : undefined,
      correlationId: rest.correlationId,
      raw: rest,
    }
  }

  async cancelSubscription(_providerSubscriptionId: string): Promise<void> {
    // Nada que cancelar: se deja de emitir links de pago.
    logger.log('info', 'ConfioProvider: suscripción cancelada (se dejan de emitir links)')
  }

  async savePaymentMethod(_params: SaveMethodParams): Promise<{ setupUrl: string }> {
    throw new Error('ConfioPagos no soporta guardar métodos de pago')
  }

  async removePaymentMethod(_providerMethodId: string): Promise<void> {
    throw new Error('ConfioPagos no soporta métodos de pago')
  }

  /**
   * ConfioPagos valida el webhook con el mismo access token en el header
   * Authorization: Bearer — no hay secreto de firma separado. Aquí `signature`
   * es el token recibido. Comparación en tiempo constante.
   */
  validateWebhookSignature(_payload: Buffer, signature: string): boolean {
    if (!this.accessToken) {
      // Sin token configurado: solo permitir fuera de producción.
      const isProd = process.env.GO_ENV === 'production' || process.env.NODE_ENV === 'production'
      if (isProd) {
        logger.log('error', 'ConfioProvider: access token no configurado en producción — webhook rechazado')
        return false
      }
      logger.log('warn', 'ConfioProvider: access token no configurado, validación de webhook omitida (solo dev)')
      return true
    }

    const received = Buffer.from(signature || '')
    const expected = Buffer.from(this.accessToken)
    if (received.length !== expected.length) return false
    return timingSafeEqual(received, expected)
  }

  /**
   * Mapea un estado crudo de ConfioPagos a nuestro estado interno de pago.
   */
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

  /** True si el estado de ConfioPagos representa un pago exitoso. */
  static isCompleted(confioStatus: string): boolean {
    return confioStatus === 'FUNDED' || confioStatus === 'DELIVERING' || confioStatus === 'APPROVED'
  }

  /**
   * ConfioPagos exige un comprador con email y teléfono E.164 (+57…).
   * Toma los datos de `metadata.buyer` si vienen; si no, usa fallbacks
   * configurables (para cobros emitidos por el cron sin contexto de usuario).
   */
  private resolveBuyer(params: CreateCheckoutParams) {
    const b = params.metadata?.buyer || {}
    return {
      firstName: b.firstName || 'Cliente',
      lastName: b.lastName || 'Cubiko',
      email: b.email || process.env.CONFIO_FALLBACK_EMAIL || 'pagos@cubiko.co',
      phoneNumber: ConfioProvider.normalizeColombianPhone(b.phoneNumber),
    }
  }

  /** Metadata de ConfioPagos debe ser map<string,string>. */
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
   * Normaliza un teléfono colombiano a E.164 (+57XXXXXXXXXX). Fallback al
   * ejemplo de la documentación de ConfioPagos cuando falta o es inválido.
   */
  static normalizeColombianPhone(raw?: string): string {
    const fallback = '+573215786325' // de la documentación de ConfioPagos
    let phone = (raw || '').trim()
    if (!phone) return fallback
    if (phone.startsWith('+57') && phone.length >= 12) return phone
    phone = phone.replace(/^\+/, '')
    if (phone.length === 10 && phone[0] === '3') return '+57' + phone
    if (phone.length === 12 && phone.startsWith('57')) return '+' + phone
    return fallback
  }
}
