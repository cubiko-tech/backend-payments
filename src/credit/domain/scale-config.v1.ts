import { ScaleConfig } from './scale-config.types'

/**
 * Escala v1 — paridad EXACTA con el simulador JS de la spec
 * (`servers/roax-credito_2.html`, líneas 1860-1933): TIERS, scoreInv,
 * scoreRoasFn, scoreVent, total = round(sInv*0.4 + sRoas*0.4 + sVent*0.2).
 *
 * Los tramos se expresan por cota superior exclusiva para reproducir el
 * `if (x < n)` del simulador sin ambigüedad de bordes. Moneda base COP; los
 * montos de desembolso son por moneda (otros mercados se siembran aparte, no
 * se convierten al vuelo).
 *
 * El techo por ROAS (tierRoasCaps) es una mejora confirmada del diseño (§1.3)
 * que va MÁS ALLÁ del simulador: limita el nivel (no el cupo) por subscore ROAS.
 *
 * Esta constante es la semilla de la versión 1 de `score_scale_config`.
 */
export const SCALE_CONFIG_V1: ScaleConfig = {
  version: 1,
  baseCurrency: 'COP',
  weights: { investment: 0.4, roas: 0.4, sales: 0.2 },
  scales: {
    // scoreInv: <2M→10 <4M→30 <6M→50 <10M→70 <18M→85 else 100
    investment: [
      { upTo: 2_000_000, score: 10 },
      { upTo: 4_000_000, score: 30 },
      { upTo: 6_000_000, score: 50 },
      { upTo: 10_000_000, score: 70 },
      { upTo: 18_000_000, score: 85 },
      { upTo: null, score: 100 },
    ],
    // scoreRoasFn: <1.5→0 <2.0→15 <2.5→30 <3.0→50 <3.5→65 <4.5→80 <6.0→92 else 100
    roas: [
      { upTo: 1.5, score: 0 },
      { upTo: 2.0, score: 15 },
      { upTo: 2.5, score: 30 },
      { upTo: 3.0, score: 50 },
      { upTo: 3.5, score: 65 },
      { upTo: 4.5, score: 80 },
      { upTo: 6.0, score: 92 },
      { upTo: null, score: 100 },
    ],
    // scoreVent: <5M→10 <10M→30 <20M→50 <40M→70 <70M→88 else 100
    sales: [
      { upTo: 5_000_000, score: 10 },
      { upTo: 10_000_000, score: 30 },
      { upTo: 20_000_000, score: 50 },
      { upTo: 40_000_000, score: 70 },
      { upTo: 70_000_000, score: 88 },
      { upTo: null, score: 100 },
    ],
  },
  vetoes: { minRoas: 3.0 },
  tierRoasCaps: { growthSeller: 65, proMarketer: 80, elite: 92 },
  tiers: [
    { key: 'no_eligible', name: 'No elegible', scoreMin: 0, scoreMax: 39, disbursement: 0, commission: null },
    { key: 'starter', name: 'Starter Ads', scoreMin: 40, scoreMax: 54, disbursement: 1_000_000, commission: 0.035 },
    { key: 'builder', name: 'Builder', scoreMin: 55, scoreMax: 64, disbursement: 1_500_000, commission: 0.03 },
    { key: 'growth_seller', name: 'Growth Seller', scoreMin: 65, scoreMax: 74, disbursement: 2_000_000, commission: 0.025 },
    { key: 'pro_marketer', name: 'Pro Marketer', scoreMin: 75, scoreMax: 84, disbursement: 2_000_000, commission: 0.0225 },
    { key: 'elite', name: 'Elite', scoreMin: 85, scoreMax: 100, disbursement: 2_000_000, commission: 0.02 },
  ],
}
