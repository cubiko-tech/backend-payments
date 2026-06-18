import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectQueue } from '@nestjs/bullmq'
import { Queue } from 'bullmq'
import { In, Repository } from 'typeorm'

import { RequestException } from '../shared/exception/request.exception'
import { ScoreRun, ScoreRunStatus } from './entities/scoreRun.entity'
import { CreditScore } from './entities/creditScore.entity'
import { CreditInputsClient } from './client/credit-inputs.client'
import { ScaleConfigService } from './scale-config.service'
import { CreditService } from './credit.service'
import { validateWholeMonths } from './period.util'

export const CREDIT_RUN_QUEUE = 'credit-run'

const PAGE_SIZE = 100

/**
 * Runs masivos de scoring (Fase 3). `createRun` valida el período, garantiza un
 * único run activo por período y encola un job BullMQ durable. `executeRun` es el
 * cuerpo del worker: pagina las marcas puntuables desde processes, puntúa por
 * lote y persiste snapshots con `runId`. Es idempotente/reanudable: salta las
 * marcas que ya tienen snapshot para ese run, así un job que murió a mitad se
 * reanuda sin duplicar. Ver DISEÑO_SCORING_CREDITO §6.2, §6.3.
 */
@Injectable()
export class CreditRunService {
  private readonly logger = new Logger(CreditRunService.name)

  constructor(
    @InjectRepository(ScoreRun, 'DBWrite')
    private readonly runRepo: Repository<ScoreRun>,
    @InjectRepository(ScoreRun, 'DBRead')
    private readonly runReadRepo: Repository<ScoreRun>,
    @InjectRepository(CreditScore, 'DBRead')
    private readonly scoreReadRepo: Repository<CreditScore>,
    @InjectQueue(CREDIT_RUN_QUEUE)
    private readonly queue: Queue,
    private readonly client: CreditInputsClient,
    private readonly scaleConfig: ScaleConfigService,
    private readonly creditService: CreditService,
  ) {}

  /** Crea un run (pending) y lo encola. Rechaza si ya hay uno activo del período. */
  async createRun(params: {
    periodStart: string
    periodEnd: string
    triggeredBy: string
  }): Promise<ScoreRun> {
    const { periodStart, periodEnd, triggeredBy } = params

    const { error } = validateWholeMonths(periodStart, periodEnd, Date.now())
    if (error) {
      throw new RequestException(
        { error: error.message, code: error.code },
        HttpStatus.BAD_REQUEST,
      )
    }

    const active = await this.runReadRepo.findOne({
      where: {
        periodStart,
        periodEnd,
        status: In([ScoreRunStatus.PENDING, ScoreRunStatus.RUNNING]),
      },
    })
    if (active) {
      throw new RequestException(
        { error: 'Ya hay un run activo para este período', code: 'runAlreadyActive' },
        HttpStatus.CONFLICT,
      )
    }

    const run = await this.runRepo.save(
      this.runRepo.create({
        periodStart,
        periodEnd,
        status: ScoreRunStatus.PENDING,
        triggeredBy,
      }),
    )

    await this.queue.add(
      'process-run',
      { runId: run.id },
      {
        jobId: run.id, // dedup: un job por run
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    )

    return run
  }

  async getRun(id: string): Promise<ScoreRun> {
    const run = await this.runReadRepo.findOne({ where: { id } })
    if (!run) {
      throw new RequestException(
        { error: 'Run no encontrado', code: 'runNotFound' },
        HttpStatus.NOT_FOUND,
      )
    }
    return run
  }

  async listRuns(limit = 50): Promise<ScoreRun[]> {
    return this.runReadRepo.find({ order: { createdAt: 'DESC' }, take: limit })
  }

  /**
   * Cuerpo del worker. Reanudable: reconstruye el set de marcas ya puntuadas para
   * este run y las salta. Los contadores derivados de snapshots son la verdad;
   * `errors` (marcas que no llegaron a snapshot) es best-effort por ejecución.
   */
  async executeRun(runId: string): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } })
    if (!run) {
      this.logger.warn(`Run ${runId} no encontrado, descartando job`)
      return
    }
    if (run.status === ScoreRunStatus.COMPLETED) {
      this.logger.log(`Run ${runId} ya completado, no-op`)
      return
    }

    const { error, months: requestedMonths } = validateWholeMonths(
      run.periodStart,
      run.periodEnd,
      Date.now(),
    )
    if (error) {
      this.logger.error(`Run ${runId} con período inválido al ejecutar: ${error.message}`)
      await this.computeAndSave(run, { errors: 0, status: ScoreRunStatus.FAILED, finished: true })
      return
    }

    const { config, version } = await this.scaleConfig.getActiveConfig()

    run.status = ScoreRunStatus.RUNNING
    await this.runRepo.save(run)

    // Reanudación: marcas ya puntuadas en este run (no recalcular ni duplicar).
    const done = new Set(
      (
        await this.scoreReadRepo.find({ where: { runId }, select: ['brandId'] })
      ).map((s) => s.brandId),
    )

    let page = 1
    let total = 0
    let errors = 0

    do {
      const pageRes = await this.client.discoverBrands(page, PAGE_SIZE)
      total = pageRes.total

      const pending = pageRes.data.filter((b) => !done.has(b))
      if (pending.length) {
        const inputs = await this.client.getBatch(pending, run.periodStart, run.periodEnd)
        const byBrand = new Map(inputs.map((i) => [i.brandId, i]))

        for (const brandId of pending) {
          const brandInputs = byBrand.get(brandId)
          if (!brandInputs) {
            this.logger.warn(`Run ${runId}: sin insumos para ${brandId}`)
            errors++
            continue
          }
          try {
            await this.creditService.scoreInputs(brandInputs, config, version, {
              periodStart: run.periodStart,
              periodEnd: run.periodEnd,
              requestedMonths,
              triggeredBy: run.triggeredBy,
              runId,
            })
            done.add(brandId)
          } catch (e) {
            if (isUniqueViolation(e)) {
              // Carrera/reintento: el snapshot ya existe; idempotente.
              done.add(brandId)
            } else {
              this.logger.error(`Run ${runId}: error puntuando ${brandId}: ${asMessage(e)}`)
              errors++
            }
          }
        }
      }

      await this.computeAndSave(run, { totalBrands: total, errors })
      page++
    } while ((page - 1) * PAGE_SIZE < total)

    await this.computeAndSave(run, {
      totalBrands: total,
      errors,
      status: ScoreRunStatus.COMPLETED,
      finished: true,
    })
    this.logger.log(`Run ${runId} completado: ${total} marcas, ${errors} errores`)
  }

  /** Marca el run como fallido (lo invoca el processor en el intento final). */
  async markFailed(runId: string): Promise<void> {
    const run = await this.runRepo.findOne({ where: { id: runId } })
    if (!run || run.status === ScoreRunStatus.COMPLETED) return
    await this.computeAndSave(run, { errors: run.errors, status: ScoreRunStatus.FAILED, finished: true })
  }

  /**
   * Deriva los contadores de los snapshots del run y persiste el progreso. Una
   * sola query agregada por `scoreStatus`; `errors` se pasa por fuera.
   */
  private async computeAndSave(
    run: ScoreRun,
    opts: { totalBrands?: number; errors: number; status?: ScoreRunStatus; finished?: boolean },
  ): Promise<void> {
    const rows = await this.scoreReadRepo
      .createQueryBuilder('s')
      .select('s.scoreStatus', 'scoreStatus')
      .addSelect('COUNT(*)', 'count')
      .where('s.runId = :runId', { runId: run.id })
      .groupBy('s.scoreStatus')
      .getRawMany<{ scoreStatus: string; count: string }>()

    let processed = 0
    let eligible = 0
    let vetoed = 0
    let insufficient = 0
    for (const r of rows) {
      const n = Number(r.count)
      processed += n
      if (r.scoreStatus === 'scored') eligible += n
      else if (r.scoreStatus === 'vetoed_roas') vetoed += n
      else if (r.scoreStatus === 'insufficient_data' || r.scoreStatus === 'fx_unavailable') {
        insufficient += n
      }
    }

    run.processed = processed
    run.eligible = eligible
    run.vetoed = vetoed
    run.insufficient = insufficient
    run.errors = opts.errors
    if (opts.totalBrands !== undefined) run.totalBrands = opts.totalBrands
    if (opts.status) run.status = opts.status
    if (opts.finished) run.finishedAt = new Date()
    await this.runRepo.save(run)
  }
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505'
}

function asMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
