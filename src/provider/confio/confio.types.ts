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
