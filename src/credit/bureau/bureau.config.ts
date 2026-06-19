import { BureauBand } from '../domain/scale-config.types'

/**
 * Resultado normalizado de un provider de buró. El motor de score solo conoce
 * las cuatro bandas; el mapeo puntaje crudo → banda es config por provider.
 * Ver DISEÑO_SCORING_CREDITO §4.
 */
export interface BureauScore {
  rawScore: number
  scale: number
  raw: unknown
  checkedAt: Date
}

/**
 * Provider de buró (patrón multi-provider de payments). `manual` no implementa
 * `getScore` (un operador carga el puntaje obtenido por fuera); los providers de
 * API (datacredito) sí. Se agrega cuando haya contrato.
 */
export interface BureauProvider {
  readonly name: string
  getScore(document: string, documentType: string, country: string): Promise<BureauScore>
}

/** Umbrales puntaje→banda por provider. `below` exclusivo, de menor a mayor. */
export interface BandThresholds {
  vetoBelow: number
  highRiskBelow: number
  mediumRiskBelow: number
  scaleMax: number
}

/**
 * Config por provider (rev. 2 del doc usa la escala Datacrédito 0–950). `manual`
 * reusa los mismos umbrales: el operador carga el puntaje en esa escala.
 */
export const BUREAU_THRESHOLDS: Record<string, BandThresholds> = {
  manual: { vetoBelow: 300, highRiskBelow: 500, mediumRiskBelow: 600, scaleMax: 950 },
  datacredito: { vetoBelow: 300, highRiskBelow: 500, mediumRiskBelow: 600, scaleMax: 950 },
}

export const DEFAULT_BUREAU_VALID_DAYS = 30

/** Mapea un puntaje crudo a la banda normalizada según los umbrales del provider. */
export function mapBand(rawScore: number, t: BandThresholds): BureauBand {
  if (rawScore < t.vetoBelow) return 'veto'
  if (rawScore < t.highRiskBelow) return 'high_risk'
  if (rawScore < t.mediumRiskBelow) return 'medium_risk'
  return 'clear'
}
