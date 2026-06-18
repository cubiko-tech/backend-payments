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
