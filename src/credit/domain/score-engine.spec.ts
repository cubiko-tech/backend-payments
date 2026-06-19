import { computeScore } from './score-engine'
import { SCALE_CONFIG_V1 } from './scale-config.v1'
import { BureauBand } from './scale-config.types'

/**
 * Oráculo de paridad: reimplementación literal del simulador JS de la spec
 * (`roax-credito_2.html`, líneas 1860-1933). El motor DEBE coincidir con él en
 * subscores, total, nivel-por-puntos y comisión (force de buró incluido). El
 * techo por ROAS es una mejora posterior al simulador y se prueba aparte.
 */
const SIM_TIERS = [
  { key: 'no_eligible', scoreMin: 0, com: null as number | null },
  { key: 'starter', scoreMin: 40, com: 0.035 },
  { key: 'builder', scoreMin: 55, com: 0.03 },
  { key: 'growth_seller', scoreMin: 65, com: 0.025 },
  { key: 'pro_marketer', scoreMin: 75, com: 0.0225 },
  { key: 'elite', scoreMin: 85, com: 0.02 },
]

function simScoreInv(inv: number): number {
  if (inv < 2_000_000) return 10
  if (inv < 4_000_000) return 30
  if (inv < 6_000_000) return 50
  if (inv < 10_000_000) return 70
  if (inv < 18_000_000) return 85
  return 100
}
function simScoreRoas(r: number): number {
  if (r < 1.5) return 0
  if (r < 2.0) return 15
  if (r < 2.5) return 30
  if (r < 3.0) return 50
  if (r < 3.5) return 65
  if (r < 4.5) return 80
  if (r < 6.0) return 92
  return 100
}
function simScoreVent(v: number): number {
  if (v < 5_000_000) return 10
  if (v < 10_000_000) return 30
  if (v < 20_000_000) return 50
  if (v < 40_000_000) return 70
  if (v < 70_000_000) return 88
  return 100
}
function simulate(dc: number, inv: number, roas: number, ventas: number) {
  const sInv = simScoreInv(inv)
  const sRoas = simScoreRoas(roas)
  const sVent = simScoreVent(ventas)
  const total = Math.round(sInv * 0.4 + sRoas * 0.4 + sVent * 0.2)
  const dcVeto = dc < 300
  const roasVeto = roas < 3.0
  const dcForce = !dcVeto && dc < 500
  let tier = SIM_TIERS[0]
  if (!dcVeto && !roasVeto) {
    for (let i = SIM_TIERS.length - 1; i >= 1; i--) {
      if (total >= SIM_TIERS[i].scoreMin) {
        tier = SIM_TIERS[i]
        break
      }
    }
  }
  const comRate = dcForce && tier.com !== null ? 0.035 : tier.com
  return { sInv, sRoas, sVent, total, tierKey: tier.key, comRate }
}

/** Puntaje crudo Datacrédito → banda normalizada que recibe el motor. */
function bandFromDc(dc: number): BureauBand {
  if (dc < 300) return 'veto'
  if (dc < 500) return 'high_risk'
  if (dc < 600) return 'medium_risk'
  return 'clear'
}

describe('computeScore — paridad con el simulador JS', () => {
  const invValues = [1_000_000, 3_000_000, 5_000_000, 8_000_000, 15_000_000, 25_000_000]
  const roasValues = [1.0, 1.7, 2.3, 2.8, 3.2, 4.0, 5.0, 7.0]
  const ventValues = [2_000_000, 7_000_000, 15_000_000, 30_000_000, 55_000_000, 90_000_000]
  const dcValues = [250, 400, 550, 700] // veto, high_risk, medium, clear

  it('coincide en subscores, total, nivel-por-puntos y comisión en toda la grilla', () => {
    for (const dc of dcValues) {
      for (const inv of invValues) {
        for (const roas of roasValues) {
          for (const ventas of ventValues) {
            const sim = simulate(dc, inv, roas, ventas)
            const result = computeScore(
              { monthlyInvestment: inv, roasValue: roas, monthlySales: ventas },
              SCALE_CONFIG_V1,
              bandFromDc(dc),
            )

            const label = `dc=${dc} inv=${inv} roas=${roas} ventas=${ventas}`
            expect(`${label}:${result.subscores.investment}`).toBe(`${label}:${sim.sInv}`)
            expect(`${label}:${result.subscores.roas}`).toBe(`${label}:${sim.sRoas}`)
            expect(`${label}:${result.subscores.sales}`).toBe(`${label}:${sim.sVent}`)
            expect(`${label}:${result.total}`).toBe(`${label}:${sim.total}`)
            // El simulador no aplica techo por ROAS → comparar el nivel-por-puntos.
            expect(`${label}:${result.tierByScore}`).toBe(`${label}:${sim.tierKey}`)

            // Comisión: del nivel-por-puntos + force de buró (sin techo, como el simulador).
            const uncapped = SCALE_CONFIG_V1.tiers.find((t) => t.key === result.tierByScore)
            let expectedCom = uncapped?.commission ?? null
            if (bandFromDc(dc) === 'high_risk' && expectedCom !== null) expectedCom = 0.035
            expect(`${label}:${expectedCom}`).toBe(`${label}:${sim.comRate}`)
          }
        }
      }
    }
  })
})

describe('computeScore — techo de nivel por ROAS (mejora §1.3)', () => {
  const maxInv = 25_000_000 // sInv = 100
  const maxVent = 90_000_000 // sVent = 100

  it('86 pts con ROAS 3.2x (sRoas 65) → Elite por puntos, limitado a Growth Seller', () => {
    const r = computeScore(
      { monthlyInvestment: maxInv, roasValue: 3.2, monthlySales: maxVent },
      SCALE_CONFIG_V1,
      'clear',
    )
    expect(r.total).toBe(86)
    expect(r.tierByScore).toBe('elite')
    expect(r.tier).toBe('growth_seller')
    expect(r.tierCappedBy).toBe('roas')
    expect(r.conditions.commission).toBe(0.025)
  })

  it('ROAS 4.0x (sRoas 80) → techo Pro Marketer', () => {
    const r = computeScore(
      { monthlyInvestment: maxInv, roasValue: 4.0, monthlySales: maxVent },
      SCALE_CONFIG_V1,
      'clear',
    )
    expect(r.tierByScore).toBe('elite')
    expect(r.tier).toBe('pro_marketer')
    expect(r.tierCappedBy).toBe('roas')
  })

  it('ROAS 5.0x (sRoas 92) → sin techo, Elite', () => {
    const r = computeScore(
      { monthlyInvestment: maxInv, roasValue: 5.0, monthlySales: maxVent },
      SCALE_CONFIG_V1,
      'clear',
    )
    expect(r.tier).toBe('elite')
    expect(r.tierCappedBy).toBeNull()
  })

  it('el techo nunca promueve: total bajo no sube de nivel por buen ROAS', () => {
    // inv 1M (10), roas 7 (100), ventas 2M (10) → total = round(4+40+2)=46 → Starter.
    const r = computeScore(
      { monthlyInvestment: 1_000_000, roasValue: 7.0, monthlySales: 2_000_000 },
      SCALE_CONFIG_V1,
      'clear',
    )
    expect(r.total).toBe(46)
    expect(r.tier).toBe('starter')
    expect(r.tierCappedBy).toBeNull()
  })
})

describe('computeScore — vetos y gate de buró', () => {
  it('ROAS < 3.0 → vetoed_roas y No elegible sin importar el total', () => {
    const r = computeScore(
      { monthlyInvestment: 25_000_000, roasValue: 2.8, monthlySales: 90_000_000 },
      SCALE_CONFIG_V1,
      'clear',
    )
    expect(r.scoreStatus).toBe('vetoed_roas')
    expect(r.tier).toBe('no_eligible')
    expect(r.conditions.commission).toBeNull()
  })

  it('buró veto → No elegible aunque el score sea alto', () => {
    const r = computeScore(
      { monthlyInvestment: 25_000_000, roasValue: 5.0, monthlySales: 90_000_000 },
      SCALE_CONFIG_V1,
      'veto',
    )
    expect(r.tier).toBe('no_eligible')
    expect(r.conditions.commission).toBeNull()
    // El cálculo sigue siendo "scored" (el veto de buró es eje de elegibilidad).
    expect(r.scoreStatus).toBe('scored')
  })

  it('buró high_risk → comisión forzada al máximo (3.5%)', () => {
    // Elite sin buró pagaría 2.0%.
    const r = computeScore(
      { monthlyInvestment: 25_000_000, roasValue: 5.0, monthlySales: 90_000_000 },
      SCALE_CONFIG_V1,
      'high_risk',
    )
    expect(r.tier).toBe('elite')
    expect(r.conditions.commission).toBe(0.035)
  })

  it('buró medium_risk / clear → comisión normal del nivel', () => {
    for (const band of ['medium_risk', 'clear'] as BureauBand[]) {
      const r = computeScore(
        { monthlyInvestment: 25_000_000, roasValue: 5.0, monthlySales: 90_000_000 },
        SCALE_CONFIG_V1,
        band,
      )
      expect(r.conditions.commission).toBe(0.02)
    }
  })

  it('cupo semanal = 3× desembolso', () => {
    const r = computeScore(
      { monthlyInvestment: 5_000_000, roasValue: 3.2, monthlySales: 7_000_000 },
      SCALE_CONFIG_V1,
      'clear',
    )
    expect(r.conditions.weeklyQuota).toBe(r.conditions.disbursement * 3)
  })
})
