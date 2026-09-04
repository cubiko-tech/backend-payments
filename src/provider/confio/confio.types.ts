/**
 * Contrato de la API de suscripciones de ConfioPagos.
 *
 * Destilado de su spec OpenAPI (vendorizado en `roax-ops/planning/confio-openapi.json`)
 * y verificado contra una respuesta real del store de dev el 2026-08-25.
 *
 * Vive aparte del provider a propósito: `confio.provider.ts` ya está cerca del
 * límite de tamaño del repo y el alta de suscripción agrega sus propios tipos
 * de request/response sobre estos.
 */

import { SubscriptionResult } from '../provider.interface'

/** Centinela incluido: ConfioPagos puede devolver `STATUS_UNSPECIFIED`. */
export type ConfioPlanStatus = 'STATUS_UNSPECIFIED' | 'ACTIVE' | 'INACTIVE' | 'ARCHIVED'

/** Centinela incluido: ConfioPagos puede devolver `BILLING_FREQUENCY_UNSPECIFIED`. */
export type ConfioBillingFrequency = 'BILLING_FREQUENCY_UNSPECIFIED' | 'MONTHLY' | 'WEEKLY'

/**
 * Plan recurrente tal como lo devuelve ConfioPagos. Todos los campos son
 * obligatorios en su spec salvo `description`; se listan completos para poder
 * verificar que lo que guardaron es lo que pedimos (el monto queda congelado).
 */
export interface ConfioSubscriptionPlan {
  /** Resource name: `stores/{store}/subscription-plans/{plan}` (con guiones). */
  name: string
  displayName: string
  description?: string
  /** En CENTAVOS. */
  amountCents: number
  currencyCode: string
  billingCycleFrequency: ConfioBillingFrequency
  billingCycleInterval: number
  trialPeriodDays: number
  status: ConfioPlanStatus
  createTime: string
  updateTime: string
}

/**
 * Alta de plan. `displayName` y `amountCents` son los únicos obligatorios para
 * ConfioPagos, pero acá se exigen los cuatro: dejar que apliquen sus defaults
 * (`COP`, `MONTHLY`, intervalo 1, trial 0) sería registrar un plan cuyo trial
 * de 15 días desaparece en silencio.
 */
export interface CreateConfioPlanParams {
  displayName: string
  description?: string
  /** En CENTAVOS: 19.900 COP → 1990000, 6.99 USD → 699. */
  amountCents: number
  currencyCode: string
  /** `MONTHLY` por defecto del lado nuestro; ConfioPagos también acepta `WEEKLY`. */
  billingCycleFrequency?: 'MONTHLY' | 'WEEKLY'
  /** 1–12. Frecuencia × intervalo = cada N períodos. */
  billingCycleInterval?: number
  /** 0–365. Queda CONGELADO al crear el plan. */
  trialPeriodDays: number
}

/**
 * Envelope del listado. `nextPageToken` llega como **string vacío** cuando no
 * hay más páginas (comprobado en dev), no ausente: hay que tratarlo como fin.
 */
export interface ListConfioPlansResponse {
  plans?: ConfioSubscriptionPlan[]
  nextPageToken?: string
}

// ============================================================
// Suscripciones
// ============================================================

/**
 * Los 8 estados del enum `Subscription.status` del spec vendorizado.
 *
 * Unión ESTRICTA a propósito: agregarle `| string` la colapsaría a `string` y
 * el tipo dejaría de verificar nada. Para el campo que llega por la red se usa
 * `ConfioSubscriptionStatusWire`, que sí tolera un valor nuevo.
 */
export type ConfioSubscriptionStatus =
  | 'PENDING_ACCEPTANCE'
  | 'ACTIVE'
  | 'PROCESSING'
  | 'TRIALING'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'EXPIRED'
  | 'SUSPENDED'

/**
 * El estado tal como VIENE de ConfioPagos. `(string & {})` conserva el
 * autocompletado de los 8 literales y a la vez deja pasar un estado que Confío
 * agregue mañana: el mapeo es passthrough, así que prometer la unión estricta
 * sería mentir sobre lo que el objeto realmente contiene.
 */
export type ConfioSubscriptionStatusWire = ConfioSubscriptionStatus | (string & {})

/**
 * Comprador de la suscripción. Los CUATRO campos son obligatorios
 * (`CreateSubscriptionRequest.buyer.required` del spec vendorizado), y
 * `firstName`/`lastName` van de 3 a 64 caracteres.
 */
export interface ConfioBuyer {
  email: string
  /** E.164, con `+` y código de país: `+573215786325`. */
  phoneNumber: string
  /** 3–64 caracteres. */
  firstName: string
  /** 3–64 caracteres. */
  lastName: string
}

/** Alta de suscripción — `POST …/subscription-plans/{plan}/subscriptions`. */
export interface CreateConfioSubscriptionParams {
  /**
   * Resource name COMPLETO del plan: `stores/{store}/subscription-plans/{plan}`.
   * Nunca el id suelto: de un id no se puede componer la ruta, y un plan de otro
   * store da un 404 mudo (los planes son POR AMBIENTE).
   */
  planName: string
  buyer: ConfioBuyer
  /** Nuestro identificador para correlacionar. Máx. 128 caracteres. */
  correlationId?: string
  /**
   * Monto SÓLO del primer ciclo, en centavos. `minimum: 0` en el spec, y el 0
   * es válido: significa primer ciclo gratis. Por eso el body se arma con
   * `!== undefined` y no por truthiness.
   */
  firstChargeAmountCents?: number
  /** A dónde vuelve el comprador después de aceptar. */
  redirectUri?: string
  /**
   * Vencimiento del link de aceptación (ISO-8601). El spec exige entre 1 hora y
   * 30 días desde la creación; default 7 días.
   */
  acceptanceExpireTime?: string
}

/**
 * Suscripción tal como la devuelve ConfioPagos (verbatim).
 *
 * Obligatorios según el spec: `name`, `status`, `buyer`, `createTime`. El resto
 * depende del estado:
 * - `acceptanceUrl` **sólo viaja mientras el estado es `PENDING_ACCEPTANCE`**.
 * - `currentPeriodStart` / `currentPeriodEnd` / `nextBillingTime` no existen
 *   hasta que el comprador acepta: el alta NO cobra ni abre período.
 */
export interface ConfioSubscription {
  /** `stores/{store}/subscription-plans/{plan}/subscriptions/{sub}`. */
  name: string
  status: ConfioSubscriptionStatusWire
  buyer: ConfioBuyer
  createTime: string
  correlationId?: string
  firstChargeAmountCents?: number
  redirectUri?: string
  /** Link portador: quien lo tenga registra una tarjeta. Sólo en `PENDING_ACCEPTANCE`. */
  acceptanceUrl?: string
  acceptanceExpireTime?: string
  currentPeriodStart?: string
  currentPeriodEnd?: string
  nextBillingTime?: string
}

/**
 * Resultado normalizado del alta y de la consulta de una suscripción.
 *
 * Extiende `SubscriptionResult` (el contrato común de `PaymentProvider`) con lo
 * que ConfioPagos agrega. Ojo: **`getSubscription` NO está en `PaymentProvider`**,
 * así que se consume con el tipo concreto `ConfioProvider` (inyectado o
 * instanciado directo), no por `ProviderFactory.getProvider()`, que devuelve la
 * interfaz y no ve este método.
 */
export interface ConfioSubscriptionResult extends SubscriptionResult {
  /** El `name` de ConfioPagos: el resource name completo, no un uuid. */
  providerSubscriptionId: string
  status: ConfioSubscriptionStatusWire
  /**
   * Heredado de `SubscriptionResult` como `Date` OBLIGATORIO, pero en
   * `PENDING_ACCEPTANCE` ConfioPagos no lo manda y llega `undefined` en runtime.
   * Declararlo opcional rompe el `implements` ("Property is optional ... but
   * required"), y con `strictNullChecks: false` en este tsconfig TS tampoco
   * protegería al llamador si lo fuera. El arreglo real es ensanchar
   * `provider.interface.ts`: deuda de otra tarea. Chequealo antes de usarlo.
   */
  currentPeriodStart: Date
  /** Mismo caso que `currentPeriodStart`: `undefined` hasta que el comprador acepta. */
  currentPeriodEnd: Date
  /**
   * Link portador de aceptación: el "único link inicial" del criterio 1. Sólo
   * viene en `PENDING_ACCEPTANCE`. No se loguea ni se persiste.
   */
  acceptanceUrl?: string
  acceptanceExpireTime?: Date
  nextBillingTime?: Date
  correlationId?: string
  /**
   * Respuesta cruda MENOS el link de aceptación. El `acceptanceUrl` se expone en
   * UN solo campo a propósito, para que un `metadata: result.raw` aguas abajo no
   * pueda persistir un link portador (restricción 3 de
   * `alta-crea-suscripcion-en-confiopagos`). Ojo igual: **`raw.buyer` es PII**
   * (email y teléfono del comprador), no lo serialices entero sin pensarlo.
   */
  raw: Omit<ConfioSubscription, 'acceptanceUrl'>
}

// ============================================================
// Webhooks
// ============================================================

/**
 * Los cuatro eventos documentados (`CONFIOPAGOS_SUSCRIPCIONES.md` §Webhooks).
 * El tipo admite además cualquier string: el `event` lo dicta el emisor y un
 * evento nuevo no puede romper el handler HTTP, sólo caer al camino legacy.
 */
export type ConfioWebhookEventName =
  | 'subscription.subscriptionStatusChanged'
  | 'subscription.billingStatusChanged'
  | 'payment.statusChanged'
  | 'paymentAttempt.statusChanged'

/**
 * `data` de `subscription.billingStatusChanged`.
 *
 * Todo opcional salvo nada: el cobro exitoso trae `payment`, y el fallido trae
 * `failedCount` + `reason` en su lugar. Tipar como obligatorio lo que varía por
 * resultado haría que el contrato mienta sobre el payload fallido.
 */
export interface ConfioBillingStatusChangedData {
  /** Resource name de la suscripción: `stores/…/subscription-plans/…/subscriptions/…`. */
  name?: string
  /** Resource name del pago; sólo en el cobro exitoso. */
  payment?: string
  cycleNumber?: number
  amountCents?: number
  currencyCode?: string
  /** `SUCCEEDED` en el cobro exitoso; el fallido reporta su propio estado. */
  status?: string
  /** Sólo en el cobro fallido: número de intento dentro del ciclo. */
  failedCount?: number
  /** Sólo en el cobro fallido. */
  reason?: string
  createTime?: string
  correlationId?: string
}

/**
 * `data` de `subscription.subscriptionStatusChanged`: creación, aceptación,
 * mora, suspensión y cancelación viajan todas por acá, distinguidas por
 * `status` (`PENDING_ACCEPTANCE`, `ACTIVE`, `TRIALING`, `PAST_DUE`, `CANCELED`,
 * `EXPIRED`, `SUSPENDED`).
 */
export interface ConfioSubscriptionStatusChangedData {
  name?: string
  status?: string
  createTime?: string
  updateTime?: string
  correlationId?: string
}

/**
 * Envelope común de todo webhook de ConfioPagos. `signature.properties` dicta
 * qué campos de `data` entran al checksum, en ese orden exacto.
 */
export interface ConfioWebhookPayload {
  event?: ConfioWebhookEventName | string
  data?: ConfioBillingStatusChangedData & ConfioSubscriptionStatusChangedData & Record<string, any>
  /** Epoch en segundos; entra al checksum, así que una reentrega lo repite igual. */
  timestamp?: number | string
  signature?: {
    properties?: string[]
    checksum?: string
  }
}
