/**
 * Tipos del motor de scoring de crédito (dominio puro, sin I/O).
 *
 * La política completa (pesos, tramos, vetos, techos, niveles) vive en
 * configuración versionada (`score_scale_config.config` jsonb), nunca en código.
 * Estos tipos describen esa config y los resultados del motor.
 * Ver backend-payments/docs/DISEÑO_SCORING_CREDITO.md §1 y §7.
 */

/** Tramo de escala por cota superior exclusiva (paridad con el `if (x < n)` del simulador JS). */
export interface ScaleBracket {
  /** Cota superior EXCLUSIVA del tramo; `null` = sin tope (último tramo). */
  upTo: number | null
  /** Subscore 0–100 asignado al tramo. */
  score: number
}

export interface TierConfig {
  key: string
  name: string
  scoreMin: number
  scoreMax: number
  /** Monto de desembolso en la moneda base de la escala. */
  disbursement: number
  /** Comisión por desembolso (fracción, ej. 0.035 = 3.5%); `null` = no elegible. */
  commission: number | null
}

export interface ScaleConfig {
  version: number
  baseCurrency: string
  weights: { investment: number, roas: number, sales: number }
  scales: {
    investment: ScaleBracket[]
    roas: ScaleBracket[]
    sales: ScaleBracket[]
  }
  vetoes: { minRoas: number }
  /**
   * Subscore ROAS mínimo para alcanzar cada nivel alto (techo por eficiencia).
   * Ej. { growthSeller: 65, proMarketer: 80, elite: 92 }.
   */
  tierRoasCaps: { growthSeller: number, proMarketer: number, elite: number }
  tiers: TierConfig[]
}

/** Banda normalizada de buró (el motor no conoce el puntaje crudo del provider). */
export type BureauBand = 'veto' | 'high_risk' | 'medium_risk' | 'clear'

export interface ScoreInput {
  /** Inversión Meta mensual promedio del período, en moneda base. */
  monthlyInvestment: number
  /** ROAS del período = sum(revenue)/sum(spend) ponderado. Adimensional. */
  roasValue: number
  /** Ventas entregadas mensuales promedio del período, en moneda base. */
  monthlySales: number
}

export type ScoreStatus = 'scored' | 'vetoed_roas'

export interface ScoreResult {
  subscores: { investment: number, roas: number, sales: number }
  roasValue: number
  total: number
  /** Nivel por puntos (antes del techo por ROAS). */
  tierByScore: string
  /** Nivel final = min(tierByScore, techo por ROAS). */
  tier: string
  /** Causa del recorte cuando el techo actúa; `null` si no recortó. */
  tierCappedBy: 'roas' | null
  conditions: {
    disbursement: number
    weeklyQuota: number
    /** Comisión final, ya con el force de buró high_risk aplicado. */
    commission: number | null
  }
  scoreStatus: ScoreStatus
}
