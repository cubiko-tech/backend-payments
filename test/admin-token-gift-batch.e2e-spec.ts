/**
 * Mass token gift batches (`POST /admin/token-wallets/gift-batches/preview`,
 * `POST /admin/token-wallets/gift-batches`, `GET /admin/token-wallets/gift-batches/:id`) and the
 * per-brand gift cap over HTTP against PostgreSQL (LOC-253).
 * R6: one responsibility, the admin token gift batch endpoints and worker lifecycle behind one test
 * app and database; splitting would duplicate the schema and auth setup.
 */
import { getQueueToken } from '@nestjs/bullmq'
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { Job } from 'bullmq'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AddTokenWalletOrigins1793949572497 } from '../migrations/1793949572497-AddTokenWalletOrigins'
import { AddTokenGiftBatches1794300000000 } from '../migrations/1794300000000-AddTokenGiftBatches'
import { AddTokenGiftNotices1794350000000 } from '../migrations/1794350000000-AddTokenGiftNotices'
import { AdminTokenGiftController } from '../src/admin/admin-token-gift.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { TokenGiftBatch } from '../src/wallet/entities/token-gift-batch.entity'
import { TokenGiftBatchItem } from '../src/wallet/entities/token-gift-batch-item.entity'
import { TokenGiftNotice } from '../src/wallet/entities/token-gift-notice.entity'
import { Wallet, WalletProvider, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { TokenGiftBatchProcessor } from '../src/wallet/token-gift-batch.processor'
import {
  TOKEN_GIFT_BATCH_QUEUE,
  TokenGiftBatchService,
} from '../src/wallet/token-gift-batch.service'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { unknownServiceKeys } from './support/service-credential.double'

dotenvConfig({ path: '.env' })

const [BRAND_1, BRAND_2, BRAND_3, BRAND_4, BRAND_5] = [
  'a2530000-0000-4000-8000-000000000001',
  'a2530000-0000-4000-8000-000000000002',
  'a2530000-0000-4000-8000-000000000003',
  'a2530000-0000-4000-8000-000000000004',
  'a2530000-0000-4000-8000-000000000005',
]
const [SUPERADMIN_ID, BRAND_ADMIN_ID] = ['superadmin-loc253', 'brand-admin-loc253']
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc253-jwt-secret', 'e2e-loc253-server-token']

describe('Admin token gift batches over HTTP (PostgreSQL, LOC-253)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let processor: TokenGiftBatchProcessor
  let superAdmin = ''
  let brandAdmin = ''

  // R17: Captures BullMQ `queue.add` calls so tests can assert job deduplication and trigger worker attempts deterministically.
  const queueDouble = {
    add: jest.fn().mockResolvedValue({ id: 'job-1' }),
  }

  const http = () => request(app.getHttpServer())
  const previewBatch = (body: Record<string, unknown>, token = superAdmin) =>
    http()
      .post('/admin/token-wallets/gift-batches/preview')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const createBatch = (body: Record<string, unknown>, token = superAdmin) =>
    http()
      .post('/admin/token-wallets/gift-batches')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const getBatch = (id: string, query = '', token = superAdmin) =>
    http()
      .get(`/admin/token-wallets/gift-batches/${id}${query}`)
      .set('Authorization', `Bearer ${token}`)
  const singleGift = (brandId: string, body: Record<string, unknown>, token = superAdmin) =>
    http()
      .post(`/admin/token-wallets/${brandId}/gifts`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)

  const seedTknWallet = (
    brandId: string,
    status: WalletStatus = WalletStatus.ACTIVE,
    balance = 0,
  ) =>
    dataSource.getRepository(Wallet).save(
      dataSource.getRepository(Wallet).create({
        brandId,
        userId: brandId,
        provider: WalletProvider.INTERNAL,
        currency: 'TKN',
        balance,
        giftTokens: balance,
        purchasedTokens: 0,
        dropiTokens: 0,
        status,
      }),
    )

  const seedBulkOpenTknWallets = async (count: number) => {
    await dataSource.query(
      `INSERT INTO "wallets" ("id", "brandId", "userId", "provider", "currency", "balance", "giftTokens", "purchasedTokens", "dropiTokens", "status")
       SELECT
         uuid_generate_v4(),
         ('b2530000-0000-4000-8000-' || lpad(i::text, 12, '0')),
         ('b2530000-0000-4000-8000-' || lpad(i::text, 12, '0')),
         'internal',
         'TKN',
         0,
         0,
         0,
         0,
         'active'
       FROM generate_series(1, $1::int) AS s(i)`,
      [count],
    )
  }

  const runWorkerJob = (batchId: string, attemptsMade = 0, attempts = 3) =>
    processor.process({
      data: { batchId },
      attemptsMade,
      opts: { attempts },
    } as unknown as Job<{ batchId: string }>)

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    queueDouble.add.mockClear()
    await dataSource.query('DELETE FROM "token_gift_notices"')
    await dataSource.query('DELETE FROM "token_gift_batch_items"')
    await dataSource.query('DELETE FROM "token_gift_batches"')
    await dataSource.query(
      `DELETE FROM "audit_log" WHERE "entityType" = 'wallet' AND "entityId" IN (SELECT "id"::text FROM "wallets" WHERE "currency" = 'TKN' OR "brandId" LIKE 'a2530000-%' OR "brandId" LIKE 'b2530000-%')`,
    )
    await dataSource.query(
      `DELETE FROM "transactions" WHERE "walletId" IN (SELECT "id" FROM "wallets" WHERE "currency" = 'TKN' OR "brandId" LIKE 'a2530000-%' OR "brandId" LIKE 'b2530000-%')`,
    )
    await dataSource.query(
      `DELETE FROM "wallets" WHERE "currency" = 'TKN' OR "brandId" LIKE 'a2530000-%' OR "brandId" LIKE 'b2530000-%'`,
    )
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_SECRET,
      ACCESS_SERVER,
      TOKEN_GIFT_MAX_TOKENS_PER_BRAND: '10000',
      TOKEN_GIFT_BATCH_SIZE: '500',
    })
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [
        Wallet,
        Transaction,
        AuditLog,
        TokenGiftBatch,
        TokenGiftBatchItem,
        TokenGiftNotice,
      ],
      synchronize: false,
    })
    await dataSource.initialize()

    const runner = dataSource.createQueryRunner()
    try {
      const hasOrigins = await runner.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'wallets' AND column_name = 'giftTokens'`,
      )
      if (!hasOrigins.length) {
        await new AddTokenWalletOrigins1793949572497().up(runner)
      }
      const hasBatches = await runner.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'token_gift_batches'`,
      )
      if (!hasBatches.length) {
        await new AddTokenGiftBatches1794300000000().up(runner)
      }
      const hasNotices = await runner.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'token_gift_notices'`,
      )
      if (!hasNotices.length) {
        await new AddTokenGiftNotices1794350000000().up(runner)
      }
    } finally {
      await runner.release()
    }

    const jwtService = new JwtService({ secret: JWT_SECRET })
    superAdmin = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })
    brandAdmin = jwtService.sign({ id: BRAND_ADMIN_ID, isSuperAdmin: false, brand: BRAND_1 })

    const repo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })

    const moduleRef = await Test.createTestingModule({
      controllers: [AdminTokenGiftController],
      providers: [
        AuditService,
        TokenWalletService,
        TokenGiftBatchService,
        TokenGiftBatchProcessor,
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: JwtService, useValue: jwtService },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        { provide: getQueueToken(TOKEN_GIFT_BATCH_QUEUE), useValue: queueDouble },
        ...[
          Wallet,
          Transaction,
          AuditLog,
          TokenGiftBatch,
          TokenGiftBatchItem,
          TokenGiftNotice,
        ].flatMap((e) => [repo(e, 'DBWrite'), repo(e, 'DBRead')]),
        // R17: these routes use @RequireSuperAdmin, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
    processor = app.get(TokenGiftBatchProcessor)
  })

  beforeEach(clean, 30000)
  afterEach(() => {
    jest.restoreAllMocks()
    process.env.TOKEN_GIFT_MAX_TOKENS_PER_BRAND = '10000'
    process.env.TOKEN_GIFT_BATCH_SIZE = '500'
  })

  afterAll(async () => {
    await clean()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  }, 30000)

  it('CA6 — preview: with 4 open TKN wallets and 1 closed at 50 per brand, all_open returns 4 brands and total 200 without moving anything', async () => {
    // R15: red when preview includes closed wallets or mutates balances.
    await Promise.all([
      seedTknWallet(BRAND_1, WalletStatus.ACTIVE),
      seedTknWallet(BRAND_2, WalletStatus.ACTIVE),
      seedTknWallet(BRAND_3, WalletStatus.FROZEN),
      seedTknWallet(BRAND_4, WalletStatus.ACTIVE),
      seedTknWallet(BRAND_5, WalletStatus.CLOSED),
    ])

    const res = await previewBatch({ filter: { kind: 'all_open' }, amount: 50 })

    expect(res.status).toBe(HttpStatus.OK)
    expect(res.body.data).toEqual({
      brandCount: 4,
      amount: 50,
      totalTokens: 200,
    })
    expect(await dataSource.getRepository(Transaction).count()).toBe(0)
    expect(await dataSource.getRepository(TokenGiftBatch).count()).toBe(0)
  })

  it('CA6 — all_open: with total 200 confirmed, answers 202 with id and credits the 4 open TKN wallets with 50 while the closed one does not enter', async () => {
    // R15: red when all_open includes closed wallets or fails to credit all 4 open ones.
    const [w1, w2, w3, w4, closedWallet] = await Promise.all([
      seedTknWallet(BRAND_1, WalletStatus.ACTIVE),
      seedTknWallet(BRAND_2, WalletStatus.ACTIVE),
      seedTknWallet(BRAND_3, WalletStatus.FROZEN),
      seedTknWallet(BRAND_4, WalletStatus.ACTIVE),
      seedTknWallet(BRAND_5, WalletStatus.CLOSED),
    ])

    const createRes = await createBatch({
      filter: { kind: 'all_open' },
      amount: 50,
      confirmedTotalTokens: 200,
      reason: 'Q4 Loyalty Gift',
      idempotencyKey: 'b-01',
    })

    expect(createRes.status).toBe(HttpStatus.ACCEPTED)
    const batchId: string = createRes.body.data.id
    expect(batchId).toBeDefined()
    expect(queueDouble.add).toHaveBeenCalledWith(
      'process-gift-batch',
      { batchId },
      expect.objectContaining({ jobId: batchId, attempts: 3 }),
    )

    await runWorkerJob(batchId)

    const reportRes = await getBatch(batchId)
    expect(reportRes.status).toBe(HttpStatus.OK)
    expect(reportRes.body.data).toMatchObject({
      id: batchId,
      status: 'completed',
      totalBrands: 4,
      acreditada: 4,
      repetida: 0,
      omitida: 0,
      counts: { acreditada: 4, repetida: 0, omitida: 0, pending: 0 },
      totalCreditedTokens: 200,
      omitted: { data: [], meta: { total: 0, page: 1, limit: 20, totalPages: 0 } },
    })

    for (const w of [w1, w2, w3, w4]) {
      const updated = await dataSource.getRepository(Wallet).findOneByOrFail({ id: w.id })
      expect([Number(updated.balance), Number(updated.giftTokens)]).toEqual([50, 50])
    }
    const closedAfter = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ id: closedWallet.id })
    expect([
      closedAfter.status,
      Number(closedAfter.balance),
      Number(closedAfter.giftTokens),
    ]).toEqual([WalletStatus.CLOSED, 0, 0])
  })

  it('CA6 — chosen brands: 3 brands with TKN and 1 without it (confirmed total 200) finishes with 3 acreditada, 1 omitida sin_wallet, and 150 total credited; also reports cerrada when a chosen brand is closed', async () => {
    // R15: red when brands mode creates a TKN wallet for BRAND_4 (getOrCreate) or omits the sin_wallet/cerrada reason.
    await Promise.all([
      seedTknWallet(BRAND_1, WalletStatus.ACTIVE),
      seedTknWallet(BRAND_2, WalletStatus.ACTIVE),
      seedTknWallet(BRAND_3, WalletStatus.ACTIVE),
    ])
    // BRAND_4 has a COP money wallet to verify LEFT JOIN only matches internal/TKN.
    await dataSource.getRepository(Wallet).save(
      dataSource.getRepository(Wallet).create({
        brandId: BRAND_4,
        userId: BRAND_4,
        provider: WalletProvider.INTERNAL,
        currency: 'COP',
        balance: 50000,
        status: WalletStatus.ACTIVE,
      }),
    )

    const createRes = await createBatch({
      filter: { kind: 'brands', brandIds: [BRAND_1, BRAND_2, BRAND_3, BRAND_4] },
      amount: 50,
      confirmedTotalTokens: 200,
      reason: 'Selected brands bonus',
      idempotencyKey: 'b-02',
    })
    expect(createRes.status).toBe(HttpStatus.ACCEPTED)
    const batchId: string = createRes.body.data.id

    await runWorkerJob(batchId)

    const reportRes = await getBatch(batchId)
    expect(reportRes.status).toBe(HttpStatus.OK)
    expect(reportRes.body.data).toMatchObject({
      id: batchId,
      status: 'completed',
      totalBrands: 4,
      acreditada: 3,
      repetida: 0,
      omitida: 1,
      counts: { acreditada: 3, repetida: 0, omitida: 1, pending: 0 },
      totalCreditedTokens: 150,
      omitted: {
        data: [{ brandId: BRAND_4, walletId: null, reason: 'sin_wallet' }],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      },
    })
    expect(
      await dataSource.getRepository(Wallet).findOneBy({ brandId: BRAND_4, currency: 'TKN' }),
    ).toBeNull()

    const closedWallet = await seedTknWallet(BRAND_5, WalletStatus.CLOSED)
    const secondRes = await createBatch({
      filter: { kind: 'brands', brandIds: [BRAND_1, BRAND_4, BRAND_5] },
      amount: 50,
      confirmedTotalTokens: 150,
      reason: 'With closed and missing',
      idempotencyKey: 'b-03',
    })
    expect(secondRes.status).toBe(HttpStatus.ACCEPTED)
    await runWorkerJob(secondRes.body.data.id)

    const page1 = await getBatch(secondRes.body.data.id, '?page=1&limit=1')
    const page2 = await getBatch(secondRes.body.data.id, '?page=2&limit=1')
    expect(page1.body.data.omitted).toEqual({
      data: [{ brandId: BRAND_4, walletId: null, reason: 'sin_wallet' }],
      meta: { total: 2, page: 1, limit: 1, totalPages: 2 },
    })
    expect(page2.body.data.omitted).toEqual({
      data: [{ brandId: BRAND_5, walletId: closedWallet.id, reason: 'cerrada' }],
      meta: { total: 2, page: 2, limit: 1, totalPages: 2 },
    })
  })

  it('CA6 — repeat: repeating the same idempotencyKey returns the same operation without creating or enqueuing a second gift, while a different payload under the same key returns 409', async () => {
    // R15: red when createBatch inserts a second batch or re-enqueues a completed batch on replay.
    await Promise.all([seedTknWallet(BRAND_1), seedTknWallet(BRAND_2)])
    const body = {
      filter: { kind: 'all_open' },
      amount: 50,
      confirmedTotalTokens: 100,
      reason: 'Idempotent batch',
      idempotencyKey: 'b-04',
    }

    const first = await createBatch(body)
    expect(first.status).toBe(HttpStatus.ACCEPTED)
    await runWorkerJob(first.body.data.id)
    queueDouble.add.mockClear()

    // Open a 3rd wallet after the batch completed: repeating the same key must still return the first batch.
    await seedTknWallet(BRAND_3)
    const second = await createBatch(body)

    expect(second.status).toBe(HttpStatus.ACCEPTED)
    expect(second.body.data.id).toBe(first.body.data.id)
    expect(second.body.data.status).toBe('completed')
    expect(second.body.data.totalCreditedTokens).toBe(100)
    expect(queueDouble.add).not.toHaveBeenCalled()
    expect(await dataSource.getRepository(TokenGiftBatch).count()).toBe(1)
    expect(await dataSource.getRepository(Transaction).count()).toBe(2)

    const conflict = await createBatch({ ...body, amount: 60, confirmedTotalTokens: 120 })
    expect(conflict.status).toBe(HttpStatus.CONFLICT)
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT')
  })

  it('CA6 — volume: with 10,000 open TKN wallets, creating a batch answers 202 in under 2s using INSERT ... SELECT without reading wallets into memory', async () => {
    // R15: red when createBatch loads wallet rows into memory instead of using INSERT ... SELECT.
    await seedBulkOpenTknWallets(10000)
    const walletRepo = dataSource.getRepository(Wallet)
    const findSpy = jest.spyOn(walletRepo, 'find')
    const findBySpy = jest.spyOn(walletRepo, 'findBy')

    const startMs = Date.now()
    const res = await createBatch({
      filter: { kind: 'all_open' },
      amount: 50,
      confirmedTotalTokens: 500000,
      reason: '10k volume test',
      idempotencyKey: 'b-05',
    })
    const elapsedMs = Date.now() - startMs

    expect(res.status).toBe(HttpStatus.ACCEPTED)
    expect(elapsedMs).toBeLessThan(2000)
    expect(res.body.data.totalBrands).toBe(10000)
    expect(findSpy).not.toHaveBeenCalled()
    expect(findBySpy).not.toHaveBeenCalled()
    expect(
      await dataSource.getRepository(TokenGiftBatchItem).countBy({ batchId: res.body.data.id }),
    ).toBe(10000)
  })

  it('CA6 — crash and resumption: with 10,000 wallets, when the job crashes mid-way right after creditTokens commits on the 5,000th wallet, resuming finishes with 10,000 acreditada and each brand credited once', async () => {
    // R15: red when the per-brand key stops including the brand or is omitted: resumption either double-credits the 5,000th wallet (balance 100) or fails to credit all 10,000.
    await seedBulkOpenTknWallets(10000)

    const createRes = await createBatch({
      filter: { kind: 'all_open' },
      amount: 50,
      confirmedTotalTokens: 500000,
      reason: '10k crash and resume',
      idempotencyKey: 'b-06',
    })
    expect(createRes.status).toBe(HttpStatus.ACCEPTED)
    const batchId: string = createRes.body.data.id

    const tokens = app.get(TokenWalletService)
    const origCreditTokens = tokens.creditTokens.bind(tokens)
    let callsInFirstRun = 0
    let crashedMidFlight = false
    // R17: Simulates a worker process crash at the 5,000th wallet right after creditTokens committed its transaction and before the batch item row is marked acreditada.
    const spy = jest
      .spyOn(tokens, 'creditTokens')
      .mockImplementation(async (...args: Parameters<TokenWalletService['creditTokens']>) => {
        const result = await origCreditTokens(...args)
        callsInFirstRun++
        if (!crashedMidFlight && callsInFirstRun === 5000) {
          crashedMidFlight = true
          throw new Error('Worker killed mid-batch after creditTokens commit')
        }
        return result
      })

    await expect(runWorkerJob(batchId, 0, 3)).rejects.toThrow(
      'Worker killed mid-batch after creditTokens commit',
    )
    spy.mockRestore()

    const midReport = await getBatch(batchId)
    expect(midReport.body.data.status).toBe('running')
    expect(midReport.body.data.acreditada).toBeLessThan(10000)
    expect(midReport.body.data.acreditada).toBeGreaterThanOrEqual(4990)

    // Force the resumed worker attempt to re-evaluate the first 5,000 brands against their per-brand transaction keys:
    await dataSource.query(
      `UPDATE "token_gift_batch_items" SET "outcome" = 'pending', "creditedAmount" = 0 WHERE "batchId" = $1`,
      [batchId],
    )

    await runWorkerJob(batchId, 1, 3)

    const finalReport = await getBatch(batchId)
    expect(finalReport.status).toBe(HttpStatus.OK)
    expect(finalReport.body.data).toMatchObject({
      id: batchId,
      status: 'completed',
      totalBrands: 10000,
      acreditada: 10000,
      repetida: 0,
      omitida: 0,
      totalCreditedTokens: 500000,
    })

    const [walletStats] = await dataSource.query(
      `SELECT
         COUNT(*)::int AS "total",
         COUNT(*) FILTER (WHERE "balance" = 50 AND "giftTokens" = 50)::int AS "creditedOnce",
         COUNT(*) FILTER (WHERE "balance" > 50)::int AS "doubleCredited",
         SUM("balance")::numeric AS "sumBalance"
       FROM "wallets"
       WHERE "brandId" LIKE 'b2530000-%' AND "currency" = 'TKN'`,
    )
    expect(walletStats).toEqual({
      total: 10000,
      creditedOnce: 10000,
      doubleCredited: 0,
      sumBalance: '500000.00',
    })
    expect(await dataSource.getRepository(Transaction).count()).toBe(10000)
  }, 60000)

  it('Security — set changed: preview sees 4 open TKN wallets (total 200), a 5th TKN wallet opens before create, and create with confirmed total 200 answers 409 with the new count (5, total 250) and moves nothing', async () => {
    // R15: red when createBatch skips recounting against confirmedTotalTokens: credits 5 brands and answers 202.
    await Promise.all([
      seedTknWallet(BRAND_1),
      seedTknWallet(BRAND_2),
      seedTknWallet(BRAND_3),
      seedTknWallet(BRAND_4),
    ])

    const preview = await previewBatch({ filter: { kind: 'all_open' }, amount: 50 })
    expect(preview.status).toBe(HttpStatus.OK)
    expect(preview.body.data).toEqual({ brandCount: 4, amount: 50, totalTokens: 200 })

    await seedTknWallet(BRAND_5)

    const createRes = await createBatch({
      filter: { kind: 'all_open' },
      amount: 50,
      confirmedTotalTokens: 200,
      reason: 'Stale preview total',
      idempotencyKey: 'b-07',
    })

    expect(createRes.status).toBe(HttpStatus.CONFLICT)
    expect(createRes.body).toMatchObject({
      code: 'GIFT_BATCH_TOTAL_MISMATCH',
      brandCount: 5,
      amount: 50,
      totalTokens: 250,
    })
    expect(queueDouble.add).not.toHaveBeenCalled()
    expect(await dataSource.getRepository(TokenGiftBatch).count()).toBe(0)
    expect(await dataSource.getRepository(TokenGiftBatchItem).count()).toBe(0)
    expect(await dataSource.getRepository(Transaction).count()).toBe(0)
  })

  it('Security — per-brand cap: 10,001 tokens per brand in preview or create answers 400 and moves nothing', async () => {
    // R15: red when PreviewGiftBatchDto or CreateGiftBatchDto drops @MaxGiftTokensPerBrand().
    await seedTknWallet(BRAND_1)

    const previewRes = await previewBatch({ filter: { kind: 'all_open' }, amount: 10001 })
    const createRes = await createBatch({
      filter: { kind: 'all_open' },
      amount: 10001,
      confirmedTotalTokens: 10001,
      reason: 'Over cap',
      idempotencyKey: 'b-08',
    })

    expect([previewRes.status, createRes.status]).toEqual([
      HttpStatus.BAD_REQUEST,
      HttpStatus.BAD_REQUEST,
    ])
    expect(queueDouble.add).not.toHaveBeenCalled()
    expect(await dataSource.getRepository(TokenGiftBatch).count()).toBe(0)
    expect(await dataSource.getRepository(Transaction).count()).toBe(0)
  })

  it('Single-brand gift cap: 10,001 tokens to POST /admin/token-wallets/:brandId/gifts answers 400 and moves nothing, while 10,000 succeeds', async () => {
    // R15: red when GiftTokensDto keeps MAX_MONEY_AMOUNT instead of @MaxGiftTokensPerBrand().
    const overCap = await singleGift(BRAND_1, {
      amount: 10001,
      reason: 'Over single gift cap',
      idempotencyKey: 'b-09',
    })
    expect(overCap.status).toBe(HttpStatus.BAD_REQUEST)
    expect(
      await dataSource.getRepository(Wallet).findOneBy({ brandId: BRAND_1, currency: 'TKN' }),
    ).toBeNull()

    const atCap = await singleGift(BRAND_1, {
      amount: 10000,
      reason: 'At single gift cap',
      idempotencyKey: 'b-10',
    })
    expect(atCap.status).toBe(HttpStatus.CREATED)
    const wallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ brandId: BRAND_1, currency: 'TKN' })
    expect(Number(wallet.giftTokens)).toBe(10000)
  })

  it.each([
    [
      'empty reason',
      {
        filter: { kind: 'all_open' },
        amount: 50,
        confirmedTotalTokens: 50,
        reason: '',
        idempotencyKey: 'b-11',
      },
    ],
    [
      'blank reason',
      {
        filter: { kind: 'all_open' },
        amount: 50,
        confirmedTotalTokens: 50,
        reason: '   ',
        idempotencyKey: 'b-12',
      },
    ],
    [
      'exponent amount 1e-7',
      {
        filter: { kind: 'all_open' },
        amount: 1e-7,
        confirmedTotalTokens: 50,
        reason: 'Valid',
        idempotencyKey: 'b-13',
      },
    ],
    [
      'string amount',
      {
        filter: { kind: 'all_open' },
        amount: '50',
        confirmedTotalTokens: 50,
        reason: 'Valid',
        idempotencyKey: 'b-14',
      },
    ],
    [
      'null amount',
      {
        filter: { kind: 'all_open' },
        amount: null,
        confirmedTotalTokens: 50,
        reason: 'Valid',
        idempotencyKey: 'b-15',
      },
    ],
    [
      'over-column amount 1e20',
      {
        filter: { kind: 'all_open' },
        amount: 1e20,
        confirmedTotalTokens: 50,
        reason: 'Valid',
        idempotencyKey: 'b-16',
      },
    ],
    [
      'exponent confirmedTotalTokens 1e-7',
      {
        filter: { kind: 'all_open' },
        amount: 50,
        confirmedTotalTokens: 1e-7,
        reason: 'Valid',
        idempotencyKey: 'b-17',
      },
    ],
    [
      'null filter',
      {
        filter: null,
        amount: 50,
        confirmedTotalTokens: 50,
        reason: 'Valid',
        idempotencyKey: 'b-18',
      },
    ],
    [
      'brandIds on all_open',
      {
        filter: { kind: 'all_open', brandIds: [BRAND_1] },
        amount: 50,
        confirmedTotalTokens: 50,
        reason: 'Valid',
        idempotencyKey: 'b-19',
      },
    ],
    [
      'empty brandIds on brands',
      {
        filter: { kind: 'brands', brandIds: [] },
        amount: 50,
        confirmedTotalTokens: 50,
        reason: 'Valid',
        idempotencyKey: 'b-20',
      },
    ],
    [
      'duplicate brandIds on brands',
      {
        filter: { kind: 'brands', brandIds: [BRAND_1, BRAND_1] },
        amount: 50,
        confirmedTotalTokens: 100,
        reason: 'Valid',
        idempotencyKey: 'b-21',
      },
    ],
    [
      'non-UUID brandId on brands',
      {
        filter: { kind: 'brands', brandIds: ['not-a-uuid'] },
        amount: 50,
        confirmedTotalTokens: 50,
        reason: 'Valid',
        idempotencyKey: 'b-22',
      },
    ],
  ])(
    'Security — validation (%s): answers 400 and never 500, moving nothing',
    async (_label, body) => {
      // R15: red when DTO validators drop reason, amount, total, or filter shape checks.
      await seedTknWallet(BRAND_1)

      const res = await createBatch(body as Record<string, unknown>)

      expect(res.status).toBe(HttpStatus.BAD_REQUEST)
      expect(await dataSource.getRepository(TokenGiftBatch).count()).toBe(0)
    },
  )

  it('Security — more than 100 chosen brands: 101 brandIds in brands answers 400 and moves nothing', async () => {
    // R15: red when GiftBatchFilterDto drops @ArrayMaxSize(100).
    const brandIds = Array.from(
      { length: 101 },
      (_, idx) => `c2530000-0000-4000-8000-${String(idx + 1).padStart(12, '0')}`,
    )

    const previewRes = await previewBatch({ filter: { kind: 'brands', brandIds }, amount: 10 })
    const createRes = await createBatch({
      filter: { kind: 'brands', brandIds },
      amount: 10,
      confirmedTotalTokens: 1010,
      reason: 'Too many chosen brands',
      idempotencyKey: 'b-23',
    })

    expect([previewRes.status, createRes.status]).toEqual([
      HttpStatus.BAD_REQUEST,
      HttpStatus.BAD_REQUEST,
    ])
    expect(await dataSource.getRepository(TokenGiftBatch).count()).toBe(0)
  })

  it('Security — server token: ACCESS_SERVER gets 403 on preview, create, and report', async () => {
    // R15: red when @RequireSessionUser() is missing from AdminTokenGiftController.
    await seedTknWallet(BRAND_1)

    const previewRes = await previewBatch(
      { filter: { kind: 'all_open' }, amount: 50 },
      ACCESS_SERVER,
    )
    const createRes = await createBatch(
      {
        filter: { kind: 'all_open' },
        amount: 50,
        confirmedTotalTokens: 50,
        reason: 'Server token attempt',
        idempotencyKey: 'b-24',
      },
      ACCESS_SERVER,
    )
    const reportRes = await getBatch(BRAND_1, '', ACCESS_SERVER)

    expect([previewRes.status, createRes.status, reportRes.status]).toEqual([
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
    ])
    expect(await dataSource.getRepository(TokenGiftBatch).count()).toBe(0)
  })

  it('Security — non-superadmin session: a brand admin gets 403 on preview, create, and report', async () => {
    // R15: red when @RequireSuperAdmin() is missing from AdminTokenGiftController.
    await seedTknWallet(BRAND_1)

    const previewRes = await previewBatch({ filter: { kind: 'all_open' }, amount: 50 }, brandAdmin)
    const createRes = await createBatch(
      {
        filter: { kind: 'all_open' },
        amount: 50,
        confirmedTotalTokens: 50,
        reason: 'Brand admin attempt',
        idempotencyKey: 'b-25',
      },
      brandAdmin,
    )
    const reportRes = await getBatch(BRAND_1, '', brandAdmin)

    expect([previewRes.status, createRes.status, reportRes.status]).toEqual([
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
    ])
    expect(await dataSource.getRepository(TokenGiftBatch).count()).toBe(0)
  })

  it('Security — single-gift key imitating the batch: a single gift to brand B with key batch:<k>:<B> followed by a batch with key <k> credits B in both (acreditada, not repetida)', async () => {
    // R15: red when the per-brand batch key returns to the admin: namespace (admin:batch:<k>:<brandId>): B comes out repetida and receives only 50 instead of 100.
    await Promise.all([seedTknWallet(BRAND_1), seedTknWallet(BRAND_2)])
    const batchKey = 'b-26'

    const singleRes = await singleGift(BRAND_2, {
      amount: 50,
      reason: 'Prior single gift',
      idempotencyKey: `batch:${batchKey}:${BRAND_2}`,
    })
    expect(singleRes.status).toBe(HttpStatus.CREATED)

    const createRes = await createBatch({
      filter: { kind: 'brands', brandIds: [BRAND_1, BRAND_2] },
      amount: 50,
      confirmedTotalTokens: 100,
      reason: 'Batch after single gift',
      idempotencyKey: batchKey,
    })
    expect(createRes.status).toBe(HttpStatus.ACCEPTED)
    const batchId: string = createRes.body.data.id

    await runWorkerJob(batchId)

    const reportRes = await getBatch(batchId)
    expect(reportRes.body.data).toMatchObject({
      status: 'completed',
      acreditada: 2,
      repetida: 0,
      omitida: 0,
      totalCreditedTokens: 100,
    })

    const walletB = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ brandId: BRAND_2, currency: 'TKN' })
    expect([Number(walletB.balance), Number(walletB.giftTokens)]).toEqual([100, 100])
    const txsB = await dataSource.getRepository(Transaction).findBy({ brandId: BRAND_2 })
    expect(txsB).toHaveLength(2)
  })

  it('Security — author without session in the worker: each brand movement and audit row records the super admin who created the batch, never server or empty', async () => {
    // R15: red when executeBatch records server or empty userId instead of batch.authorId.
    const [w1, w2] = await Promise.all([seedTknWallet(BRAND_1), seedTknWallet(BRAND_2)])

    const createRes = await createBatch({
      filter: { kind: 'all_open' },
      amount: 35,
      confirmedTotalTokens: 70,
      reason: 'Audited batch gift',
      idempotencyKey: 'b-27',
    })
    expect(createRes.status).toBe(HttpStatus.ACCEPTED)
    const batchId: string = createRes.body.data.id

    await runWorkerJob(batchId)

    for (const wallet of [w1, w2]) {
      const [tx] = await dataSource.getRepository(Transaction).findBy({ walletId: wallet.id })
      expect(tx).toMatchObject({
        referenceType: 'admin',
        referenceId: SUPERADMIN_ID,
        description: 'Audited batch gift',
      })
      expect(tx.metadata).toMatchObject({
        authorId: SUPERADMIN_ID,
        reason: 'Audited batch gift',
        giftBatchId: batchId,
      })

      const [audit] = await dataSource
        .getRepository(AuditLog)
        .findBy({ entityType: 'wallet', entityId: wallet.id })
      expect(audit).toMatchObject({
        userId: SUPERADMIN_ID,
        action: 'token_gift',
        entityType: 'wallet',
        entityId: wallet.id,
        description: 'Gift of 35 tokens: Audited batch gift',
      })
      expect(audit.changes).toMatchObject({
        brandId: wallet.brandId,
        amount: 35,
        reason: 'Audited batch gift',
        transactionId: tx.id,
        giftBatchId: batchId,
      })
    }
  })

  it('marks the operation failed when retries are exhausted, keeping and reconciling what was already credited', async () => {
    // R15: red when onFailed does not call markFailed or loses already-committed credits.
    await Promise.all([seedTknWallet(BRAND_1), seedTknWallet(BRAND_2)])

    const createRes = await createBatch({
      filter: { kind: 'brands', brandIds: [BRAND_1, BRAND_2] },
      amount: 40,
      confirmedTotalTokens: 80,
      reason: 'Partial failure batch',
      idempotencyKey: 'b-28',
    })
    const batchId: string = createRes.body.data.id

    const tokens = app.get(TokenWalletService)
    const origCreditTokens = tokens.creditTokens.bind(tokens)
    let callCount = 0
    let firstCommit: Promise<unknown> | undefined
    // R17: Forces the first brand's creditTokens to commit and then crashes before settleItem on the final retry attempt.
    jest
      .spyOn(tokens, 'creditTokens')
      .mockImplementation(async (...args: Parameters<TokenWalletService['creditTokens']>) => {
        if (++callCount === 1) {
          firstCommit = origCreditTokens(...args)
          await firstCommit
          throw new Error('Fatal crash after first brand committed')
        }
        await firstCommit
        throw new Error('Database unreachable for second brand')
      })

    await expect(runWorkerJob(batchId, 2, 3)).rejects.toThrow()
    await processor.onFailed({
      data: { batchId },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as unknown as Job<{ batchId: string }>)

    const reportRes = await getBatch(batchId)
    expect(reportRes.status).toBe(HttpStatus.OK)
    expect(reportRes.body.data).toMatchObject({
      id: batchId,
      status: 'failed',
      acreditada: 1,
      repetida: 0,
      omitida: 0,
      totalCreditedTokens: 40,
    })
    expect(reportRes.body.data.finishedAt).not.toBeNull()
  })
})
