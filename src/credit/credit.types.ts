import { BureauBand } from './domain/scale-config.types'

/**
 * Estado del cálculo (eje 1). Superconjunto del `ScoreStatus` del motor puro:
 * añade los estados que decide el service (fx, cobertura). Ver §5 del diseño.
 */
export type SnapshotScoreStatus =
  | 'scored'
  | 'vetoed_roas'
  | 'insufficient_data'
  | 'fx_unavailable'

/** Gate de buró sobre el resultado (eje 2). Ver §5 del diseño. */
export type EligibilityStatus =
  | 'eligible'
  | 'vetoed_bureau'
  | 'bureau_pending'
  | 'not_applicable'

/** Un insumo monetario con su crudo, moneda, fx y convertido a base. */
export interface MonetaryInput {
  raw: number
  currency: string
  fxRate: number | null
  fxRateDate: string | null
  converted: number | null
}

export interface SnapshotInputs {
  adSpend: MonetaryInput
  revenueMeta: MonetaryInput
  salesDelivered: MonetaryInput
}

export interface SnapshotSubscores {
  investment: number
  roas: number
  sales: number
  roasValue: number
}

export interface SnapshotConditions {
  disbursement: number
  weeklyQuota: number
  commission: number | null
}

export interface BureauContext {
  checkId: string | null
  band: BureauBand | null
}

/** Estado del pre-aprobado en forma amigable para el cliente (Fase 6). */
export type PreapprovalStatus = 'eligible' | 'in_review' | 'not_eligible' | 'no_data'

export type CreditActivationRequestStatus =
  | 'pending'
  | 'contacted'
  | 'qualified'
  | 'rejected'
  | 'activated'

export type CreditActivationRequestSource = 'dropi'

/**
 * Estados "abiertos" de una solicitud: mientras esté en alguno, no se permite
 * crear otra (y el front no debe ofrecer el botón de activar).
 */
export type OpenActivationStatus = Extract<
  CreditActivationRequestStatus,
  'pending' | 'contacted' | 'qualified'
>

/**
 * Resumen de la solicitud de activación abierta de la marca, para que el front
 * sepa que ya solicitó y oculte el CTA en vez de chocar contra un 409.
 */
export interface PreapprovalActivationRequest {
  status: OpenActivationStatus
  createdAt: string
}

/**
 * Bloque de score con DATOS PROPIOS de la marca (su gasto Meta, ROAS y ventas).
 * No es dato de buró: son los insumos del propio usuario y el puntaje derivado,
 * apto para mostrarse al cliente. La banda de buró NO se incluye aquí.
 */
/**
 * Datos estructurados para "cómo subir de nivel" (sin texto formateado, para
 * que el front arme el copy con su i18n). null si ya está en el tier tope.
 */
export interface PreapprovalNextStep {
  tier: string // key del próximo tier, ej. 'pro_marketer'
  tierName: string
  pointsToNext: number
  commission: number | null
  weeklyQuota: number
  weakest: 'investment' | 'roas' | 'sales' // subscore con más margen de mejora
}

export interface PreapprovalScore {
  total: number
  subscores: { investment: number; roas: number; sales: number }
  nextStep: PreapprovalNextStep | null
}

/**
 * Pre-aprobado curado para el cliente: estado + términos + (opcional) el score
 * con datos propios. Sin banda de buró ni insumos crudos sensibles.
 * Ver DISEÑO_SCORING_CREDITO §9.
 */
export interface Preapproval {
  brandId: string
  status: PreapprovalStatus
  tier: string | null
  amount: number | null
  weeklyQuota: number | null
  commission: number | null
  currency: string
  updatedAt: string | null
  score: PreapprovalScore | null
  // Solicitud de activación abierta (si existe); null si la marca puede solicitar.
  activationRequest: PreapprovalActivationRequest | null
}
