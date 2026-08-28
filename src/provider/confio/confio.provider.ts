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
 * `cancelSubscription` cancela DE VERDAD (`POST …/{sub}/cancel`, con `reason`
 * obligatorio). Medido contra dev el 2026-08-27: se puede cancelar incluso en
 * `PENDING_ACCEPTANCE`, la suscripción queda en `CANCELED`, el `acceptanceUrl`
 * desaparece y la respuesta trae cuerpo VACÍO — la confirmación es el HTTP 200,
 * no un objeto de vuelta. Cancelar dos veces también da 200: es idempotente, así
 * que reintentar es seguro y no hace falta preguntar antes si ya estaba cancelada.
 *
 * ⚠️ `CONFIO_API_BASE_URL` **ya termina en `/v1`** y `confioFetch` concatena, así
 * que los paths van SIN ese prefijo. Con `/v1` repetido ConfioPagos responde un
 * 404 en texto plano que parece «ese endpoint no existe».
 *
 * Referencia de contrato: roax-ads-back/internal/payment/.../confiopagos_client.go
 */
// El contrato de rechazo local vive en `confio-subscription-error.ts` y se
// RE-EXPORTA acá: `confio-buyer.ts` lo necesita y el provider importa a
// `confio-buyer.ts`, así que definirlo acá sería un ciclo de módulos que en
// CommonJS deja la clase `undefined` en tiempo de evaluación. El re-export
// mantiene vivo el import histórico `from './confio.provider'`.
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
    // Normalizador ÚNICO del comprador: `confio-buyer.ts`. Acá es validación de
    // BORDE (el buyer ya viene separado en campos) y no tiene reglas propias.
    const buyer = assertConfioBuyer(params.buyer)

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
    return this.assertStorePath(planName, 'planName')
  }

  /**
   * Valida que un resource name de SUSCRIPCIÓN sea de nuestro store Y tenga la
   * forma exacta, y devuelve la ruta relativa a la base.
   *
   * Es la misma guarda del alta (`assertPlanPath`) MÁS la forma, y no un lujo:
   * el `name` lo persistimos nosotros pero entra por caminos que no lo validan
   * (`POST /subscription` lo acepta del body: `providerSubscriptionId` está en la
   * lista blanca de `CreateSubscriptionDto`), así que interpolarlo crudo
   * dejaba elegir la ruta del POST que sale con NUESTRO Bearer — la suscripción
   * de otro store (el store está COMPARTIDO con backend-ads) o, vía segmentos
   * `..` que `fetch` normaliza, cualquier otro endpoint de ConfioPagos. El
   * charset cerrado (sin `.`, sin `%`, sin `#`, sin espacios) cierra de paso la
   * inyección de líneas en el log de más abajo.
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

  /** Guarda de store compartida por el alta y por la cancelación. */
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
   * Forma exacta de la ruta de una suscripción, ya recortada a `stores/`.
   * Charset cerrado a propósito: los ids de ConfioPagos son ULIDs y cualquier
   * otra cosa (un `..`, un `#`, un salto de línea) es un intento de irse de la
   * ruta, no un id.
   */
  private static readonly SUBSCRIPTION_PATH =
    /^stores\/[A-Za-z0-9_-]+\/subscription-plans\/[A-Za-z0-9_-]+\/subscriptions\/[A-Za-z0-9_-]+$/

  /**
   * Normaliza un resource name a ruta relativa a la base (que ya trae `/v1`).
   *
   * ConfioPagos devuelve algunos names prefijados con `organizations/…` (se ve
   * en el ejemplo de payload de webhook), así que se recorta todo lo anterior a
   * `stores/`. Un id suelto se rechaza: de ahí no se puede componer la ruta.
   */
  private static toSubscriptionPath(name: string): string {
    // `name` viene de `metadata` (jsonb SIN tipar): si no es string se rechaza
    // acá y no explota con un TypeError opaco más abajo.
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

  /**
   * Cancelar una suscripción — `POST …/subscription-plans/{plan}/subscriptions/{sub}/cancel`.
   *
   * **Medido contra dev el 2026-08-27**, y de ahí sale el contrato de este método:
   * ConfioPagos acepta cancelar incluso en `PENDING_ACCEPTANCE` (no hace falta
   * esperar a que el comprador acepte), la suscripción queda en `CANCELED`, el
   * `acceptanceUrl` desaparece y la respuesta viene con **cuerpo vacío** (`{}`).
   * O sea: la confirmación es el **HTTP 200**, no un objeto de vuelta — por eso
   * devuelve `void`. Cancelar dos veces también responde 200: **es idempotente**,
   * así que un reintento no necesita ninguna guarda de «ya estaba cancelada».
   *
   * `reason` es OBLIGATORIO del lado de ConfioPagos y se rechaza acá, ANTES de la
   * red, con `ConfioSubscriptionInputError` — el mismo contrato de rechazo local
   * que usa el alta y que el llamador mapea por `instanceof` + `code`, nunca por
   * el texto del mensaje.
   *
   * ⚠️ El `reason` es texto libre del usuario: NO se loguea. En el log va sólo el
   * resource name, que para ese punto ya pasó por `assertSubscriptionPath` y por
   * lo tanto no puede traer saltos de línea.
   *
   * ⚠️ La ruta se valida ENTERA antes de interpolarla (`assertSubscriptionPath`):
   * store propio + forma exacta. Sin eso, un `name` elegido por el llamador
   * dirigía este POST —con nuestro Bearer— a la suscripción de otro store o a
   * otro endpoint de la API.
   */
  async cancelSubscription(providerSubscriptionId: string, reason?: string): Promise<void> {
    this.ensureConfigured()

    // Va antes de resolver la ruta: sin `reason` la petición no puede salir, y
    // mandarla igual sería un 4xx de ConfioPagos disfrazado de fallo del canal.
    if (!String(reason || '').trim()) {
      throw new ConfioSubscriptionInputError(
        'missing_cancel_reason',
        'reason',
        'ConfioPagos exige un motivo para cancelar la suscripción',
      )
    }

    // Un `name` vacío, corrupto, de OTRO store o con forma rara (lo persistimos
    // nosotros, por caminos que no lo validan) sale por acá como rechazo LOCAL:
    // la petición nunca salió. Es la MISMA guarda que el alta, más la forma.
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
   *
   * ⚠️ **PROHIBIDO en el camino de suscripción.** Sólo lo usa `resolveBuyer`,
   * para los links de pago one-shot, donde un teléfono de contacto equivocado es
   * cosmético y el cobro es uno solo. Pegado a un cobro RECURRENTE, ese
   * `+573215786325` de la documentación es un contacto falso que se repite todos
   * los meses, y además rompe al comprador de un plan en USD. El comprador de
   * una suscripción se arma con `confio-buyer.ts`, que nunca inventa un país.
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
