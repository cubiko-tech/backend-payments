import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { In, Repository } from 'typeorm'

import { RequestException } from '../shared/exception/request.exception'
import { CreditScore } from './entities/creditScore.entity'
import { CreditActivationRequest } from './entities/creditActivationRequest.entity'
import { CreditInputs, CreditInputsClient } from './client/credit-inputs.client'
import { ScaleConfigService } from './scale-config.service'
import { BureauService } from './bureau/bureau.service'
import { computeScore, deriveWeeklyQuota } from './domain/score-engine'
import { BureauBand, ScaleConfig } from './domain/scale-config.types'
import {
  EligibilityStatus,
  MonetaryInput,
  Preapproval,
  PreapprovalNextStep,
  PreapprovalScore,
  PreapprovalStatus,
  SnapshotScoreStatus,
  CreditActivationRequestStatus,
  OpenActivationStatus,
  PreapprovalActivationRequest,
} from './credit.types'
import { CreateActivationRequestDto } from './dto/create-activation-request.dto'
import { UpdateActivationRequestDto } from './dto/update-activation-request.dto'
import {
  firstCompleteMonthStart,
  monthIndexOfYmd,
  validateWholeMonths,
} from './period.util'

/**
 * Una marca no puede tener dos solicitudes "abiertas" a la vez: mientras esté en
 * alguno de estos estados, el cliente no puede crear otra (409) y el front oculta
 * el CTA de activar. Fuente única para getPreapproval y createActivationRequest.
 */
const OPEN_ACTIVATION_STATUSES: OpenActivationStatus[] = ['pending', 'contacted', 'qualified']

/**
 * Transiciones válidas del estado de una solicitud. `rejected` y `activated` son
 * terminales. Impide reabrir una solicitud cerrada (que la devolvería a un estado
 * "abierto" y rompería el invariante de una sola solicitud abierta por marca).
 */
const ALLOWED_ACTIVATION_TRANSITIONS: Record<
  CreditActivationRequestStatus,
  CreditActivationRequestStatus[]
> = {
  pending: ['contacted', 'qualified', 'rejected'],
  contacted: ['qualified', 'rejected'],
  qualified: ['activated', 'rejected'],
  rejected: [],
  activated: [],
}

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
    @InjectRepository(CreditActivationRequest, 'DBWrite')
    private readonly activationRequestRepo: Repository<CreditActivationRequest>,
    @InjectRepository(CreditActivationRequest, 'DBRead')
    private readonly activationRequestReadRepo: Repository<CreditActivationRequest>,
    private readonly client: CreditInputsClient,
    private readonly scaleConfig: ScaleConfigService,
    private readonly bureau: BureauService,
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

    // Banda de buró vigente (si la hay): null ⇒ bureau_pending.
    const bureau = await this.bureau.getActiveBand(brandId)

    return this.scoreInputs(inputs, config, version, {
      periodStart,
      periodEnd,
      requestedMonths,
      triggeredBy,
      runId: params.runId ?? null,
      bureauBand: params.bureauBand ?? bureau?.band ?? null,
      bureauCheckId: params.bureauCheckId ?? bureau?.checkId ?? null,
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

  /**
   * Lista de scores, opcionalmente filtrada por run, ordenada por total desc
   * (ranking de marcas). Paginada. Para el detalle del run en admin.
   */
  async listScores(opts: {
    runId?: string
    page: number
    pageSize: number
  }): Promise<{ data: CreditScore[]; total: number }> {
    const qb = this.scoreReadRepo.createQueryBuilder('s')
    if (opts.runId) qb.where('s.runId = :runId', { runId: opts.runId })
    qb.orderBy('s.total', 'DESC')
      .addOrderBy('s.createdAt', 'DESC')
      .skip((opts.page - 1) * opts.pageSize)
      .take(opts.pageSize)
    const [data, total] = await qb.getManyAndCount()
    return { data, total }
  }

  /**
   * Pre-aprobado de crédito de una marca, en forma CURADA para el cliente
   * (Fase 6, informativo). No expone score crudo, banda de buró ni insumos: solo
   * estado amigable + términos (monto, cupo, comisión) cuando aplica. La causa de
   * un veto de buró NO se revela (habeas data). Ver DISEÑO_SCORING_CREDITO §9.
   */
  async getPreapproval(brandId: string): Promise<Preapproval> {
    const score = await this.scoreReadRepo.findOne({
      where: { brandId },
      order: { createdAt: 'DESC' },
    })
    if (!score) {
      return {
        brandId, status: 'no_data', tier: null, amount: null,
        weeklyQuota: null, commission: null, currency: 'COP', updatedAt: null,
        score: null, activationRequest: null,
      }
    }

    const status = this.resolvePreapprovalStatus(score)

    const showTerms = status === 'eligible' || status === 'in_review'
    const when = score.calculatedAt ?? score.createdAt

    // Solo elegible/en revisión ofrecen términos y CTA. Para vetadas/no_data no
    // hay score que mostrar (sugerir "te faltan N puntos" sería engañoso, el
    // veto manda) ni solicitud que consultar, así evitamos dos queries por poll.
    let scoreBlock: PreapprovalScore | null = null
    let activationRequest: PreapprovalActivationRequest | null = null
    if (showTerms) {
      activationRequest = await this.findOpenActivationRequest(brandId)
      const { config } = await this.scaleConfig.getActiveConfig()
      scoreBlock = {
        total: score.total,
        subscores: {
          investment: score.subscores.investment,
          roas: score.subscores.roas,
          sales: score.subscores.sales,
        },
        nextStep: this.buildNextStep(score.total, score.subscores, config),
      }
    }

    return {
      brandId,
      status,
      tier: showTerms ? score.tier : null,
      amount: showTerms ? score.conditions.disbursement : null,
      weeklyQuota: showTerms ? score.conditions.weeklyQuota : null,
      commission: showTerms ? score.conditions.commission : null,
      currency: 'COP',
      updatedAt: when ? new Date(when).toISOString() : null,
      score: scoreBlock,
      activationRequest,
    }
  }

  /**
   * Solicitud de activación abierta de la marca (la más reciente), o null. El
   * front la usa para no ofrecer el botón si ya solicitó.
   */
  private async findOpenActivationRequest(
    brandId: string,
  ): Promise<PreapprovalActivationRequest | null> {
    const open = await this.activationRequestReadRepo.findOne({
      where: { brandId, status: In(OPEN_ACTIVATION_STATUSES) },
      order: { createdAt: 'DESC' },
    })
    if (!open) return null
    return {
      status: open.status as OpenActivationStatus,
      createdAt: new Date(open.createdAt).toISOString(),
    }
  }

  async createActivationRequest(
    brandId: string,
    body: CreateActivationRequestDto,
    _requestedBy?: string | null,
  ): Promise<CreditActivationRequest> {
    const score = await this.scoreReadRepo.findOne({
      where: { brandId },
      order: { createdAt: 'DESC' },
    })
    if (!score) {
      throw new RequestException(
        { error: 'brandHasNoScore', code: 'brandHasNoScore' },
        HttpStatus.BAD_REQUEST,
      )
    }

    const status = this.resolvePreapprovalStatus(score)
    if (status !== 'eligible') {
      throw new RequestException(
        { error: 'brandNotEligible', code: 'brandNotEligible' },
        HttpStatus.BAD_REQUEST,
      )
    }

    const openRequest = await this.findOpenActivationRequest(brandId)
    if (openRequest) {
      throw new RequestException(
        { error: 'activationRequestAlreadyOpen', code: 'activationRequestAlreadyOpen' },
        HttpStatus.CONFLICT,
      )
    }

    const fullName = body.fullName.trim()
    const email = body.email.trim().toLowerCase()
    const phone = body.phone.replace(/[^\d+]/g, '')

    try {
      return await this.activationRequestRepo.save(
        this.activationRequestRepo.create({
          brandId,
          creditScoreId: score.id,
          scoreTotal: score.total,
          tier: score.tier,
          fullName,
          email,
          phone,
          source: 'dropi',
          status: 'pending',
        }),
      )
    } catch (e) {
      // Barrera real contra la carrera: el chequeo previo lee de la réplica, así
      // que dos requests concurrentes pueden pasarlo; el índice único parcial
      // rechaza la segunda inserción y la traducimos al mismo 409.
      if (isUniqueViolation(e)) {
        throw new RequestException(
          { error: 'activationRequestAlreadyOpen', code: 'activationRequestAlreadyOpen' },
          HttpStatus.CONFLICT,
        )
      }
      throw e
    }
  }

  async listActivationRequests(opts: {
    page: number
    perPage: number
    status?: CreditActivationRequestStatus
    search?: string
  }): Promise<{ data: CreditActivationRequest[]; total: number }> {
    const qb = this.activationRequestReadRepo.createQueryBuilder('r')
    if (opts.status) {
      qb.andWhere('r.status = :status', { status: opts.status })
    }
    if (opts.search) {
      qb.andWhere(
        '(r.brandId ILIKE :q OR r.email ILIKE :q OR r.fullName ILIKE :q OR r.phone ILIKE :q)',
        { q: `%${opts.search}%` },
      )
    }
    qb.orderBy('r.createdAt', 'DESC')
      .skip((opts.page - 1) * opts.perPage)
      .take(opts.perPage)

    const [data, total] = await qb.getManyAndCount()
    return { data, total }
  }

  async updateActivationRequest(
    id: string,
    body: UpdateActivationRequestDto,
    actor?: string | null,
  ): Promise<CreditActivationRequest> {
    const current = await this.activationRequestRepo.findOne({ where: { id } })
    if (!current) {
      throw new RequestException(
        { error: 'activationRequestNotFound', code: 'activationRequestNotFound' },
        HttpStatus.NOT_FOUND,
      )
    }

    if (body.status && body.status !== current.status) {
      const allowed = ALLOWED_ACTIVATION_TRANSITIONS[current.status] ?? []
      if (!allowed.includes(body.status)) {
        throw new RequestException(
          {
            error: 'invalidActivationTransition',
            code: 'invalidActivationTransition',
            from: current.status,
            to: body.status,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      current.status = body.status
    }
    if (body.notes !== undefined) current.notes = body.notes?.trim() || null
    // Quién contactó: lo carga el operador (puede no ser el admin logueado). La
    // trazabilidad de quién ejecutó la acción queda en el audit log, así que
    // aceptarlo del body es seguro.
    if (body.contactedBy !== undefined) current.contactedBy = body.contactedBy?.trim() || null
    if (body.status === 'contacted' && !current.contactedAt) {
      current.contactedAt = new Date()
      // Si el operador no especificó quién contactó, default al admin autenticado.
      if (!current.contactedBy) current.contactedBy = actor ?? null
    }

    return this.activationRequestRepo.save(current)
  }

  /**
   * Datos para subir de nivel (estructurados, sin formato — el front arma el
   * copy con su i18n). Señala la variable con menor subscore (más margen de
   * mejora). Devuelve null si ya está en el nivel tope.
   */
  private buildNextStep(
    total: number,
    subscores: { investment: number; roas: number; sales: number },
    config: ScaleConfig,
  ): PreapprovalNextStep | null {
    // El "siguiente" tier es tiers[i+1], así que el orden importa: ordenamos por
    // scoreMin para no depender de cómo venga la config.
    const tiers = [...config.tiers].sort((a, b) => a.scoreMin - b.scoreMin)
    const i = tiers.findIndex((t) => total >= t.scoreMin && total <= t.scoreMax)
    if (i < 0 || i >= tiers.length - 1) return null
    const next = tiers[i + 1]
    const weakest = (
      [
        { k: 'investment', v: subscores.investment },
        { k: 'roas', v: subscores.roas },
        { k: 'sales', v: subscores.sales },
      ] as const
    ).slice().sort((a, b) => a.v - b.v)[0].k
    return {
      tier: next.key,
      tierName: next.name,
      pointsToNext: next.scoreMin - total,
      commission: next.commission,
      weeklyQuota: deriveWeeklyQuota(next.disbursement),
      weakest,
    }
  }

  private resolvePreapprovalStatus(score: CreditScore): PreapprovalStatus {
    if (score.scoreStatus === 'insufficient_data' || score.scoreStatus === 'fx_unavailable') {
      return 'no_data'
    }
    if (score.eligibilityStatus === 'eligible') return 'eligible'
    if (score.eligibilityStatus === 'bureau_pending') return 'in_review'
    return 'not_eligible'
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

/** Violación de índice único en Postgres (p. ej. dos solicitudes abiertas). */
function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505'
}
