import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { getQueueToken } from '@nestjs/bullmq'

import { CreditRunService, CREDIT_RUN_QUEUE } from './credit-run.service'
import { CreditService } from './credit.service'
import { CreditInputsClient } from './client/credit-inputs.client'
import { ScaleConfigService } from './scale-config.service'
import { ScoreRun, ScoreRunStatus } from './entities/scoreRun.entity'
import { CreditScore } from './entities/creditScore.entity'
import { SCALE_CONFIG_V1 } from './domain/scale-config.v1'

/** Período de 3 meses cerrados, válido respecto de hoy (mar–may 2026). */
const PERIOD = { periodStart: '2026-03-01', periodEnd: '2026-06-01' }

/** QueryBuilder encadenable que termina en `getRawMany`. */
function qbMock(rows: { scoreStatus: string; count: string }[]) {
  const qb: any = {}
  for (const m of ['select', 'addSelect', 'where', 'groupBy']) {
    qb[m] = jest.fn().mockReturnValue(qb)
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows)
  return qb
}

describe('CreditRunService', () => {
  let service: CreditRunService
  let runWriteRepo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock }
  let runReadRepo: { findOne: jest.Mock; find: jest.Mock }
  let scoreReadRepo: { find: jest.Mock; createQueryBuilder: jest.Mock }
  let queue: { add: jest.Mock }
  let client: { discoverBrands: jest.Mock; getBatch: jest.Mock }
  let scaleConfig: { getActiveConfig: jest.Mock }
  let creditService: { scoreInputs: jest.Mock }

  beforeEach(async () => {
    runWriteRepo = {
      create: jest.fn((d) => d),
      save: jest.fn((d) => Promise.resolve({ id: 'run-1', ...d })),
      findOne: jest.fn(),
    }
    runReadRepo = { findOne: jest.fn(), find: jest.fn() }
    scoreReadRepo = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() =>
        qbMock([
          { scoreStatus: 'scored', count: '1' },
          { scoreStatus: 'vetoed_roas', count: '1' },
        ]),
      ),
    }
    queue = { add: jest.fn().mockResolvedValue(undefined) }
    client = { discoverBrands: jest.fn(), getBatch: jest.fn() }
    scaleConfig = {
      getActiveConfig: jest.fn().mockResolvedValue({ config: SCALE_CONFIG_V1, version: 1 }),
    }
    creditService = { scoreInputs: jest.fn().mockResolvedValue({ id: 's' }) }

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreditRunService,
        { provide: getRepositoryToken(ScoreRun, 'DBWrite'), useValue: runWriteRepo },
        { provide: getRepositoryToken(ScoreRun, 'DBRead'), useValue: runReadRepo },
        { provide: getRepositoryToken(CreditScore, 'DBRead'), useValue: scoreReadRepo },
        { provide: getQueueToken(CREDIT_RUN_QUEUE), useValue: queue },
        { provide: CreditInputsClient, useValue: client },
        { provide: ScaleConfigService, useValue: scaleConfig },
        { provide: CreditService, useValue: creditService },
      ],
    }).compile()

    service = module.get(CreditRunService)
  })

  const ins = (brandId: string) => ({
    brandId,
    currency: 'COP',
    adSpend: 1,
    revenueMeta: 0,
    salesDelivered: 1,
    salesCurrencies: ['COP'],
    coverage: { metaFirstDataAt: null, dropiFirstDataAt: null, adAccountCreatedAt: null },
    fxToBase: { currency: 'COP', rate: 1, rateDate: null },
  })

  describe('createRun', () => {
    it('rechaza un período inválido (día ≠ 01)', async () => {
      runReadRepo.findOne.mockResolvedValue(null)
      await expect(
        service.createRun({ periodStart: '2026-03-15', periodEnd: '2026-06-01', triggeredBy: 't' }),
      ).rejects.toMatchObject({ status: 400 })
      expect(queue.add).not.toHaveBeenCalled()
    })

    it('rechaza si ya hay un run activo para el período (409)', async () => {
      runReadRepo.findOne.mockResolvedValue({ id: 'otro', status: ScoreRunStatus.RUNNING })
      await expect(
        service.createRun({ ...PERIOD, triggeredBy: 't' }),
      ).rejects.toMatchObject({ status: 409 })
      expect(queue.add).not.toHaveBeenCalled()
    })

    it('crea el run y lo encola con jobId = id del run', async () => {
      runReadRepo.findOne.mockResolvedValue(null)
      const run = await service.createRun({ ...PERIOD, triggeredBy: 'manual:u1' })
      expect(run.status).toBe(ScoreRunStatus.PENDING)
      expect(queue.add).toHaveBeenCalledWith(
        'process-run',
        { runId: 'run-1' },
        expect.objectContaining({ jobId: 'run-1', attempts: 3 }),
      )
    })
  })

  describe('executeRun', () => {
    it('no hace nada si el run ya está completado', async () => {
      runWriteRepo.findOne.mockResolvedValue({ id: 'run-1', status: ScoreRunStatus.COMPLETED })
      await service.executeRun('run-1')
      expect(client.discoverBrands).not.toHaveBeenCalled()
    })

    it('puntúa todas las marcas de la página y completa el run', async () => {
      runWriteRepo.findOne.mockResolvedValue({ ...PERIOD, id: 'run-1', status: ScoreRunStatus.PENDING })
      client.discoverBrands.mockResolvedValue({ data: ['b1', 'b2'], page: 1, pageSize: 100, total: 2 })
      client.getBatch.mockResolvedValue([ins('b1'), ins('b2')])

      await service.executeRun('run-1')

      expect(creditService.scoreInputs).toHaveBeenCalledTimes(2)
      const last = runWriteRepo.save.mock.calls.at(-1)![0]
      expect(last.status).toBe(ScoreRunStatus.COMPLETED)
      expect(last.totalBrands).toBe(2)
      expect(last.processed).toBe(2)
      expect(last.eligible).toBe(1)
      expect(last.vetoed).toBe(1)
      expect(last.finishedAt).toBeInstanceOf(Date)
    })

    it('reanuda: salta marcas ya puntuadas para el run', async () => {
      runWriteRepo.findOne.mockResolvedValue({ ...PERIOD, id: 'run-1', status: ScoreRunStatus.RUNNING })
      scoreReadRepo.find.mockResolvedValue([{ brandId: 'b1' }]) // b1 ya hecha
      client.discoverBrands.mockResolvedValue({ data: ['b1', 'b2'], page: 1, pageSize: 100, total: 2 })
      client.getBatch.mockResolvedValue([ins('b2')])

      await service.executeRun('run-1')

      expect(client.getBatch).toHaveBeenCalledWith(['b2'], PERIOD.periodStart, PERIOD.periodEnd)
      expect(creditService.scoreInputs).toHaveBeenCalledTimes(1)
    })

    it('una violación de unicidad por marca no cuenta como error', async () => {
      runWriteRepo.findOne.mockResolvedValue({ ...PERIOD, id: 'run-1', status: ScoreRunStatus.PENDING })
      client.discoverBrands.mockResolvedValue({ data: ['b1'], page: 1, pageSize: 100, total: 1 })
      client.getBatch.mockResolvedValue([ins('b1')])
      creditService.scoreInputs.mockRejectedValueOnce({ code: '23505' })

      await service.executeRun('run-1')

      const last = runWriteRepo.save.mock.calls.at(-1)![0]
      expect(last.status).toBe(ScoreRunStatus.COMPLETED)
      expect(last.errors).toBe(0)
    })
  })

  describe('markFailed', () => {
    it('marca el run como failed', async () => {
      runWriteRepo.findOne.mockResolvedValue({ id: 'run-1', status: ScoreRunStatus.RUNNING, errors: 0 })
      await service.markFailed('run-1')
      const last = runWriteRepo.save.mock.calls.at(-1)![0]
      expect(last.status).toBe(ScoreRunStatus.FAILED)
      expect(last.finishedAt).toBeInstanceOf(Date)
    })
  })
})
