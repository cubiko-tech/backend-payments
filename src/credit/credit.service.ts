import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { RequestException } from '../shared/exception/request.exception'
import { CreditScore } from './entities/creditScore.entity'
import { CreditInputs, CreditInputsClient } from './client/credit-inputs.client'
import { ScaleConfigService } from './scale-config.service'
import { computeScore } from './domain/score-engine'
import { BureauBand, ScaleConfig } from './domain/scale-config.types'
import {
  EligibilityStatus,
  MonetaryInput,
  SnapshotScoreStatus,
} from './credit.types'
import {
  firstCompleteMonthStart,
  monthIndexOfYmd,
  validateWholeMonths,
} from './period.util'

interface CalculateParams {
  brandId: string
  periodStart: string
  periodEnd: string
  triggeredBy: string
  runId?: string | null
  /** Banda de buró ya resuelta (Fase 5). Sin check vigente ⇒ null ⇒ bureau_pending. */
  bureauBand?: BureauBand | null
  bureauCheckId?: string | null
}

/**
 * Orquesta el cálculo de un score: pide insumos a processes, aplica la política
 * de moneda y cobertura, normaliza a promedios mensuales, corre el motor puro y
 * persiste un snapshot inmutable. Ver DISEÑO_SCORING_CREDITO §3, §5, §6.2.
 */
@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name)

  constructor(
    @InjectRepository(CreditScore, 'DBWrite')
    private readonly scoreRepo: Repository<CreditScore>,
    @InjectRepository(CreditScore, 'DBRead')
    private readonly scoreReadRepo: Repository<CreditScore>,
    private readonly client: CreditInputsClient,
    private readonly scaleConfig: ScaleConfigService,
  ) {}

  async calculate(params: CalculateParams): Promise<CreditScore> {
    const { brandId, periodStart, periodEnd, triggeredBy } = params

    const { error, months: requestedMonths } = validateWholeMonths(
      periodStart,
      periodEnd,
      Date.now(),
    )
    if (error) {
      throw new RequestException({ error: error.message, code: error.code }, HttpStatus.BAD_REQUEST)
    }

    const [inputs] = await this.client.getBatch([brandId], periodStart, periodEnd)
    if (!inputs) {
      throw new RequestException(
        { error: `Sin insumos para la marca ${brandId}`, code: 'noInputs' },
        HttpStatus.BAD_REQUEST,
      )
    }

    const { config, version } = await this.scaleConfig.getActiveConfig()

    return this.scoreInputs(inputs, config, version, {
      periodStart,
      periodEnd,
      requestedMonths,
      triggeredBy,
      runId: params.runId ?? null,
      bureauBand: params.bureauBand ?? null,
      bureauCheckId: params.bureauCheckId ?? null,
    })
  }

  /**
   * Corre el motor sobre insumos YA traídos y persiste el snapshot. Compartido
   * por el cálculo individual y el worker del run masivo (Fase 3): el run trae
   * los insumos por página (un `getBatch` por lote) y la escala una sola vez, y
   * llama acá por marca. No revalida el período (el caller ya lo hizo).
   */
  async scoreInputs(
    inputs: CreditInputs,
    config: ScaleConfig,
    scaleVersion: number,
    ctx: {
      periodStart: string
      periodEnd: string
      requestedMonths: number
      triggeredBy: string
      runId?: string | null
      bureauBand?: BureauBand | null
      bureauCheckId?: string | null
    },
  ): Promise<CreditScore> {
    const snapshot = this.buildSnapshot(inputs, config, scaleVersion, {
      periodStart: ctx.periodStart,
      periodEnd: ctx.periodEnd,
      requestedMonths: ctx.requestedMonths,
      triggeredBy: ctx.triggeredBy,
      runId: ctx.runId ?? null,
      bureauBand: ctx.bureauBand ?? null,
      bureauCheckId: ctx.bureauCheckId ?? null,
    })
    return this.scoreRepo.save(this.scoreRepo.create(snapshot))
  }

  /** Último score (o historial) de una marca. */
  async getByBrand(brandId: string, latest: boolean): Promise<CreditScore | CreditScore[]> {
    if (latest) {
      const one = await this.scoreReadRepo.findOne({
        where: { brandId },
        order: { createdAt: 'DESC' },
      })
      if (!one) {
        throw new RequestException(
          { error: 'Sin scores para la marca', code: 'noScores' },
          HttpStatus.NOT_FOUND,
        )
      }
      return one
    }
    return this.scoreReadRepo.find({
      where: { brandId },
      order: { createdAt: 'DESC' },
      take: 100,
    })
  }

  /**
   * Arma el snapshot a partir de los insumos crudos: moneda, período efectivo,
   * normalización mensual, motor y precedencia de estados.
   */
  private buildSnapshot(
    inputs: CreditInputs,
    config: ScaleConfig,
    scaleVersion: number,
    ctx: {
      periodStart: string
      periodEnd: string
      requestedMonths: number
      triggeredBy: string
      runId: string | null
      bureauBand: BureauBand | null
      bureauCheckId: string | null
    },
  ): Partial<CreditScore> {
    const base = config.baseCurrency
    const rate = inputs.fxToBase.rate
    const rateDate = inputs.fxToBase.rateDate
    const sameCurrency = inputs.currency.toUpperCase() === base.toUpperCase()

    // Período efectivo desde la cobertura Meta (el spend/ROAS gobierna el score).
    let effectiveStart = ctx.periodStart
    let periodAdjusted = false
    if (inputs.coverage.metaFirstDataAt) {
      const firstMonth = firstCompleteMonthStart(inputs.coverage.metaFirstDataAt)
      if (monthIndexOfYmd(firstMonth) > monthIndexOfYmd(ctx.periodStart)) {
        effectiveStart = firstMonth
        periodAdjusted = true
      }
    }
    const effectiveMonths =
      monthIndexOfYmd(ctx.periodEnd) - monthIndexOfYmd(effectiveStart)

    const fxRate = sameCurrency ? 1 : rate
    const convert = (raw: number): number | null =>
      fxRate === null ? null : raw * fxRate
    const monetary = (raw: number): MonetaryInput => ({
      raw,
      currency: inputs.currency,
      fxRate,
      fxRateDate: sameCurrency ? null : rateDate,
      converted: convert(raw),
    })

    const snapshotBase: Partial<CreditScore> = {
      brandId: inputs.brandId,
      runId: ctx.runId,
      scaleVersion,
      periodStart: ctx.periodStart,
      periodEnd: ctx.periodEnd,
      effectiveStart,
      effectiveEnd: ctx.periodEnd,
      periodAdjusted,
      inputs: {
        adSpend: monetary(inputs.adSpend),
        revenueMeta: monetary(inputs.revenueMeta),
        salesDelivered: monetary(inputs.salesDelivered),
      },
      bureauCheckId: ctx.bureauCheckId,
      bureauBand: ctx.bureauBand,
      triggeredBy: ctx.triggeredBy,
    }

    // --- Estados terminales (precedencia §5): fx_unavailable > insufficient_data ---
    if (!sameCurrency && rate === null) {
      return this.terminalSnapshot(snapshotBase, 'fx_unavailable')
    }
    if (effectiveMonths < 1) {
      return this.terminalSnapshot(snapshotBase, 'insufficient_data')
    }

    // Mismatch de moneda en ventas Dropi: no bloquea, pero deja traza.
    const mismatch = inputs.salesCurrencies.filter(
      (c) => c && c.toUpperCase() !== inputs.currency.toUpperCase(),
    )
    if (mismatch.length) {
      this.logger.warn(
        `Marca ${inputs.brandId}: ventas en monedas ${mismatch.join(',')} ≠ moneda de marca ${inputs.currency}`,
      )
    }

    // --- Normalización mensual en moneda base + motor ---
    const monthlyInvestment = (inputs.adSpend * (fxRate as number)) / effectiveMonths
    const monthlySales = (inputs.salesDelivered * (fxRate as number)) / effectiveMonths
    // ROAS REAL = ventas ENTREGADAS Dropi / inversión Meta. Mide el retorno
    // efectivamente cobrado (COD, lo que repaga el crédito), no el `billing`
    // autoreportado por Meta (atribución de pixel poco fiable y a menudo 0 en
    // COD). Es un ratio → la moneda se cancela; se usan los crudos (ambos en
    // moneda de marca). El pilar de ventas (20%) usa el mismo entregado como
    // VOLUMEN absoluto; el ROAS lo usa como EFICIENCIA vs el gasto.
    const roasValue = inputs.adSpend > 0 ? inputs.salesDelivered / inputs.adSpend : 0

    const result = computeScore(
      { monthlyInvestment, roasValue, monthlySales },
      config,
      ctx.bureauBand,
    )

    const scoreStatus: SnapshotScoreStatus = result.scoreStatus // 'scored' | 'vetoed_roas'
    const eligibilityStatus = resolveEligibility(scoreStatus, result.total, ctx.bureauBand)

    return {
      ...snapshotBase,
      subscores: {
        investment: result.subscores.investment,
        roas: result.subscores.roas,
        sales: result.subscores.sales,
        roasValue: result.roasValue,
      },
      total: result.total,
      tierByScore: result.tierByScore,
      tier: result.tier,
      tierCappedBy: result.tierCappedBy,
      conditions: result.conditions,
      scoreStatus,
      eligibilityStatus,
    }
  }

  /** Snapshot sin score (fx_unavailable / insufficient_data): elegibilidad N/A. */
  private terminalSnapshot(
    snapshotBase: Partial<CreditScore>,
    scoreStatus: SnapshotScoreStatus,
  ): Partial<CreditScore> {
    return {
      ...snapshotBase,
      subscores: { investment: 0, roas: 0, sales: 0, roasValue: 0 },
      total: 0,
      tierByScore: 'no_eligible',
      tier: 'no_eligible',
      tierCappedBy: null,
      conditions: { disbursement: 0, weeklyQuota: 0, commission: null },
      scoreStatus,
      eligibilityStatus: 'not_applicable',
    }
  }
}

/**
 * Eje de elegibilidad (§5). Sin score normal, o score < 40, o veto ⇒ N/A. Con
 * score elegible, el gate de buró decide: sin check ⇒ pendiente.
 */
function resolveEligibility(
  scoreStatus: SnapshotScoreStatus,
  total: number,
  bureauBand: BureauBand | null,
): EligibilityStatus {
  if (scoreStatus !== 'scored' || total < 40) return 'not_applicable'
  if (bureauBand === 'veto') return 'vetoed_bureau'
  if (bureauBand === null) return 'bureau_pending'
  return 'eligible'
}
