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
