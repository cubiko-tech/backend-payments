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

/**
 * Bloque de score con DATOS PROPIOS de la marca (su gasto Meta, ROAS y ventas).
 * No es dato de buró: son los insumos del propio usuario y el puntaje derivado,
 * apto para mostrarse al cliente. La banda de buró NO se incluye aquí.
 */
export interface PreapprovalScore {
  total: number
  subscores: { investment: number; roas: number; sales: number }
  nextStepHint: string | null // recomendación accionable para subir de nivel
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
}
