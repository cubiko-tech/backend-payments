import {
  BureauBand,
  ScaleBracket,
  ScaleConfig,
  ScoreInput,
  ScoreResult,
  ScoreStatus,
} from './scale-config.types'

export function deriveWeeklyQuota(disbursement: number): number {
  return disbursement * 3
}

/**
 * Motor de scoring de crédito — FUNCIÓN PURA, table-driven, sin I/O ni fechas.
 *
 * `(inputs, scaleConfig, bureauBand) → resultado`. Reproduce la fórmula del
 * simulador JS de la spec y le suma el techo de nivel por ROAS (mejora del
 * diseño §1.3). Toda la política viene en `config`; el motor no conoce montos
 * ni umbrales hardcodeados. Los breakpoints del simulador son la suite de
 * tests de paridad (score-engine.spec.ts).
 */
export function computeScore(
  input: ScoreInput,
  config: ScaleConfig,
  bureauBand: BureauBand | null,
): ScoreResult {
  const sInv = lookupBracket(config.scales.investment, input.monthlyInvestment)
  const sRoas = lookupBracket(config.scales.roas, input.roasValue)
  const sVent = lookupBracket(config.scales.sales, input.monthlySales)

  const total = Math.round(
    sInv * config.weights.investment +
      sRoas * config.weights.roas +
      sVent * config.weights.sales,
  )

  const roasVeto = input.roasValue < config.vetoes.minRoas
  const bureauVeto = bureauBand === 'veto'

  const tiers = config.tiers

  // Nivel por puntos: el más alto cuyo scoreMin alcanza el total. Un veto (ROAS
  // o buró) deja "No elegible" sin importar el total (paridad con el simulador).
  let tierByScoreIdx = 0
  if (!roasVeto && !bureauVeto) {
    for (let i = tiers.length - 1; i >= 1; i--) {
      if (total >= tiers[i].scoreMin) {
        tierByScoreIdx = i
        break
      }
    }
  }

  // Techo por eficiencia: el nivel final nunca supera lo que el subscore ROAS
  // habilita. Solo recorta hacia abajo, jamás promueve.
  const capIdx = roasCapIndex(config, sRoas)
  const finalIdx = Math.min(tierByScoreIdx, capIdx)

  const tierByScore = tiers[tierByScoreIdx]
  const tier = tiers[finalIdx]
  const tierCappedBy = finalIdx < tierByScoreIdx ? 'roas' : null

  // Comisión final: high_risk de buró fuerza la comisión máxima de la escala
  // (solo si el nivel es elegible; "No elegible" no tiene comisión).
  let commission = tier.commission
  if (bureauBand === 'high_risk' && commission !== null) {
    commission = maxCommission(config)
  }

  const scoreStatus: ScoreStatus = roasVeto ? 'vetoed_roas' : 'scored'

  return {
    subscores: { investment: sInv, roas: sRoas, sales: sVent },
    roasValue: input.roasValue,
    total,
    tierByScore: tierByScore.key,
    tier: tier.key,
    tierCappedBy,
    conditions: {
      disbursement: tier.disbursement,
      weeklyQuota: deriveWeeklyQuota(tier.disbursement),
      commission,
    },
    scoreStatus,
  }
}

/** Primer tramo cuya cota superior exclusiva no se alcanza (paridad `x < upTo`). */
function lookupBracket(brackets: ScaleBracket[], value: number): number {
  for (const bracket of brackets) {
    if (bracket.upTo === null || value < bracket.upTo) {
      return bracket.score
    }
  }
  // Inalcanzable si el último tramo tiene upTo=null; salvaguarda defensiva.
  return brackets[brackets.length - 1]?.score ?? 0
}

/**
 * Índice del nivel más alto habilitado por el subscore ROAS. Los niveles por
 * debajo de Growth Seller no tienen techo (requisito 0); Growth/Pro/Elite
 * exigen el subscore de `tierRoasCaps`.
 */
function roasCapIndex(config: ScaleConfig, roasSubscore: number): number {
  let idx = 0
  for (let i = 0; i < config.tiers.length; i++) {
    if (roasSubscore >= minRoasSubscoreForTier(config, config.tiers[i].key)) {
      idx = i
    }
  }
  return idx
}

function minRoasSubscoreForTier(config: ScaleConfig, tierKey: string): number {
  switch (tierKey) {
    case 'elite':
      return config.tierRoasCaps.elite
    case 'pro_marketer':
      return config.tierRoasCaps.proMarketer
    case 'growth_seller':
      return config.tierRoasCaps.growthSeller
    default:
      return 0
  }
}

function maxCommission(config: ScaleConfig): number {
  return Math.max(...config.tiers.map((tier) => tier.commission ?? 0))
}
