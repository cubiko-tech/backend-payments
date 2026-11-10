/**
 * Brand token gift notices (`token_gift_notices`) across single gifts, gift debits, mass gift
 * batches, brand movement history, and the `AddTokenGiftNotices` migration over PostgreSQL (LOC-254).
 * R6: one responsibility, the transactional gift notice lifecycle across the three gift paths,
 * its history visibility, and its migration behind one test app and database.
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
import { DataSource, In } from 'typeorm'

import { AddTokenWalletOrigins1793949572497 } from '../migrations/1793949572497-AddTokenWalletOrigins'
import { AddTokenGiftBatches1794300000000 } from '../migrations/1794300000000-AddTokenGiftBatches'
import { AddTokenGiftNotices1794350000000 } from '../migrations/1794350000000-AddTokenGiftNotices'
import { AdminTokenGiftController } from '../src/admin/admin-token-gift.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import { TokenGiftBatch } from '../src/wallet/entities/token-gift-batch.entity'
import { TokenGiftBatchItem } from '../src/wallet/entities/token-gift-batch-item.entity'
import {
  TokenGiftNotice,
  TokenGiftNoticeStatus,
} from '../src/wallet/entities/token-gift-notice.entity'
import { Wallet, WalletProvider, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { TokenGiftBatchProcessor } from '../src/wallet/token-gift-batch.processor'
import {
  TOKEN_GIFT_BATCH_QUEUE,
  TokenGiftBatchService,
} from '../src/wallet/token-gift-batch.service'
import { TokenWalletController } from '../src/wallet/token-wallet.controller'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { failNextWriteOf } from './support/audit-failure.fixture'
import { databaseExists, withDisposableDatabase } from './support/disposable-database.fixture'
import { unknownServiceKeys } from './support/service-credential.double'
import { raceConnectionOptions } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const [BRAND_1, BRAND_2, BRAND_3] = [
  'a2540000-0000-4000-8000-000000000001',
  'a2540000-0000-4000-8000-000000000002',
  'a2540000-0000-4000-8000-000000000003',
]
const ALL_BRANDS = [BRAND_1, BRAND_2, BRAND_3]
const [SUPERADMIN_ID, BRAND_ADMIN_ID] = ['superadmin-loc254', 'brand-admin-loc254']
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc254-jwt-secret', 'e2e-loc254-server-token']

describe('Token gift notices across gifts, debits, batches, and history (PostgreSQL, LOC-254)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let adminDataSource: DataSource
  let processor: TokenGiftBatchProcessor
  let superAdmin = ''
  let brandAdmin = ''

  // R17: BullMQ queue is in-memory so tests run worker attempts deterministically against PostgreSQL.
  const queueDouble = {
    add: jest.fn().mockResolvedValue({ id: 'job-254' }),
  }

  const http = () => request(app.getHttpServer())
  const gift = (body: Record<string, unknown>, brandId = BRAND_1, token = superAdmin) =>
    http()
      .post(`/admin/token-wallets/${brandId}/gifts`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const debitGift = (body: Record<string, unknown>, brandId = BRAND_1, token = superAdmin) =>
    http()
      .post(`/admin/token-wallets/${brandId}/gift-debits`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const createBatch = (body: Record<string, unknown>, token = superAdmin) =>
    http()
      .post('/admin/token-wallets/gift-batches')
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const getMovements = (brandId = BRAND_1, token = brandAdmin) =>
    http()
      .get(`/v1/token-wallet/movements?brandId=${brandId}`)
      .set('Authorization', `Bearer ${token}`)

  const tokenWallet = (brandId = BRAND_1) =>
    dataSource.getRepository(Wallet).findOneBy({ brandId, currency: 'TKN' })
  const movementsOf = (brandId = BRAND_1) =>
    dataSource.getRepository(Transaction).find({ where: { brandId }, order: { createdAt: 'ASC' } })
  const auditsOf = (walletId: string) =>
    dataSource.getRepository(AuditLog).findBy({ entityType: 'wallet', entityId: walletId })
  const noticesOf = (brandIds: string[] = [BRAND_1]) =>
    dataSource
      .getRepository(TokenGiftNotice)
      .find({ where: { brandId: In(brandIds) }, order: { createdAt: 'ASC', id: 'ASC' } })

  const seedTknWallet = (brandId: string, giftBalance = 0) =>
    dataSource.getRepository(Wallet).save(
      dataSource.getRepository(Wallet).create({
        brandId,
        userId: brandId,
        provider: WalletProvider.INTERNAL,
        currency: 'TKN',
        balance: giftBalance,
        giftTokens: giftBalance,
        purchasedTokens: 0,
        dropiTokens: 0,
        status: WalletStatus.ACTIVE,
      }),
    )

  const runWorkerJob = (batchId: string, attemptsMade = 0, attempts = 3) =>
    processor.process({
      data: { batchId },
      attemptsMade,
      opts: { attempts },
    } as unknown as Job<{ batchId: string }>)

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    queueDouble.add.mockClear()
    await dataSource.query('DELETE FROM "token_gift_notices" WHERE "brandId" = ANY($1)', [
      ALL_BRANDS,
    ])
    await dataSource.query('DELETE FROM "token_gift_batch_items" WHERE "brandId" = ANY($1)', [
      ALL_BRANDS,
    ])
    await dataSource.query(
      `DELETE FROM "token_gift_batches" WHERE "idempotencyKey" LIKE 'loc254-%'`,
    )
    await dataSource.query(
      'DELETE FROM "audit_log" WHERE "entityType" = \'wallet\' AND "entityId" IN (SELECT "id"::text FROM "wallets" WHERE "brandId" = ANY($1))',
      [ALL_BRANDS],
    )
    await dataSource.query('DELETE FROM "transactions" WHERE "brandId" = ANY($1)', [ALL_BRANDS])
    await dataSource.query('DELETE FROM "wallets" WHERE "brandId" = ANY($1)', [ALL_BRANDS])
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_SECRET,
      ACCESS_SERVER,
      TOKEN_GIFT_MAX_TOKENS_PER_BRAND: '10000',
      TOKEN_GIFT_BATCH_SIZE: '500',
    })
    adminDataSource = new DataSource(raceConnectionOptions())
    await adminDataSource.initialize()

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
      controllers: [AdminTokenGiftController, TokenWalletController],
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
        // R17: membership lives in backend-platform; grants brand access to BRAND_ADMIN_ID on BRAND_1.
        {
          provide: ClientPlatformService,
          useValue: {
            canViewBrandCredit: jest.fn(
              async (userId: string, brandId: string) =>
                userId === BRAND_ADMIN_ID && brandId === BRAND_1,
            ),
          },
        },
        // R17: routes under test use @RequireSuperAdmin or brand membership, never granular role slugs.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
    processor = app.get(TokenGiftBatchProcessor)
  })

  beforeEach(clean)
  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await clean()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    if (adminDataSource?.isInitialized) await adminDataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it('CA7 — dar: gifting 20 with reason "prueba" writes one pending notice (+20, balanceAfter 20, key admin:loc254-g1) and stores neither "prueba" nor author in the row', async () => {
    // R15: red when AdminTokenGiftController.gift omits recordTokenGiftNotice or stores reason/author in token_gift_notices.
    const res = await gift({ amount: 20, reason: 'prueba', idempotencyKey: 'loc254-g1' })

    expect(res.status).toBe(HttpStatus.CREATED)
    const notices = await noticesOf([BRAND_1])
    expect(notices).toHaveLength(1)
    const [rawRow] = await dataSource.query('SELECT * FROM "token_gift_notices" WHERE "id" = $1', [
      notices[0].id,
    ])
    expect(Object.keys(rawRow).sort()).toEqual([
      'amount',
      'balanceAfter',
      'brandId',
      'createdAt',
      'id',
      'movementKey',
      'status',
      'updatedAt',
    ])
    const serialized = JSON.stringify(rawRow)
    expect(serialized).not.toContain('prueba')
    expect(serialized).not.toContain(SUPERADMIN_ID)
    expect({
      brandId: notices[0].brandId,
      amount: Number(notices[0].amount),
      balanceAfter: Number(notices[0].balanceAfter),
      movementKey: notices[0].movementKey,
      status: notices[0].status,
    }).toEqual({
      brandId: BRAND_1,
      amount: 20,
      balanceAfter: 20,
      movementKey: 'admin:loc254-g1',
      status: TokenGiftNoticeStatus.PENDIENTE,
    })
  })

  it('CA7 — same key: repeating the same gift request (sequentially or concurrently) keeps a single notice row and credits 20 once', async () => {
    // R15: red when replay writes a second notice row or fails on UQ_token_gift_notices_movement_key.
    const body = { amount: 20, reason: 'prueba', idempotencyKey: 'loc254-k2' }

    const [first, second] = await Promise.all([gift(body), gift(body)])
    const third = await gift(body)

    expect([first.status, second.status, third.status]).toEqual([
      HttpStatus.CREATED,
      HttpStatus.CREATED,
      HttpStatus.CREATED,
    ])
    const wallet = (await tokenWallet(BRAND_1))!
    expect([Number(wallet.balance), Number(wallet.giftTokens)]).toEqual([20, 20])
    expect(await movementsOf(BRAND_1)).toHaveLength(1)
    expect(await auditsOf(wallet.id)).toHaveLength(1)
    const notices = await noticesOf([BRAND_1])
    expect(notices).toHaveLength(1)
    expect(Number(notices[0].amount)).toBe(20)
    expect(Number(notices[0].balanceAfter)).toBe(20)
  })

  it('CA7 — quitar: debiting 5 gift tokens writes a pending notice with amount -5 and balanceAfter 15 without reason or author', async () => {
    // R15: red when AdminTokenGiftController.debitGift omits recordTokenGiftNotice or records a positive amount.
    await gift({ amount: 20, reason: 'initial gift', idempotencyKey: 'loc254-k3' })

    const debitRes = await debitGift({
      amount: 5,
      reason: 'quitar prueba',
      idempotencyKey: 'loc254-d1',
    })
    const replayDebit = await debitGift({
      amount: 5,
      reason: 'quitar prueba',
      idempotencyKey: 'loc254-d1',
    })

    expect([debitRes.status, replayDebit.status]).toEqual([HttpStatus.CREATED, HttpStatus.CREATED])
    const notices = await noticesOf([BRAND_1])
    expect(notices).toHaveLength(2)
    const debitNotice = notices.find((n) => n.movementKey === 'admin:loc254-d1')!
    expect(debitNotice).toBeDefined()
    expect({
      brandId: debitNotice.brandId,
      amount: Number(debitNotice.amount),
      balanceAfter: Number(debitNotice.balanceAfter),
      movementKey: debitNotice.movementKey,
      status: debitNotice.status,
    }).toEqual({
      brandId: BRAND_1,
      amount: -5,
      balanceAfter: 15,
      movementKey: 'admin:loc254-d1',
      status: TokenGiftNoticeStatus.PENDIENTE,
    })
    const serialized = JSON.stringify(debitNotice)
    expect(serialized).not.toContain('quitar prueba')
    expect(serialized).not.toContain(SUPERADMIN_ID)
  })

  it('CA7 — a muchas: a gift batch over 3 brands with TKN writes 3 pending notices (one per brand) without reason or author, and a worker replay writes none more', async () => {
    // R15: red when TokenGiftBatchService.processItem skips recordTokenGiftNotice for batch items.
    await Promise.all([
      seedTknWallet(BRAND_1, 10),
      seedTknWallet(BRAND_2, 0),
      seedTknWallet(BRAND_3, 5),
    ])

    const createRes = await createBatch({
      filter: { kind: 'brands', brandIds: [BRAND_1, BRAND_2, BRAND_3] },
      amount: 20,
      confirmedTotalTokens: 60,
      reason: 'motivo lote secreto',
      idempotencyKey: 'loc254-k4',
    })
    expect(createRes.status).toBe(HttpStatus.ACCEPTED)
    const batchId: string = createRes.body.data.id

    await runWorkerJob(batchId)

    await dataSource.query(
      `UPDATE "token_gift_batch_items" SET "outcome" = 'pending', "creditedAmount" = 0 WHERE "batchId" = $1`,
      [batchId],
    )
    await dataSource.query(`UPDATE "token_gift_batches" SET "status" = 'running' WHERE "id" = $1`, [
      batchId,
    ])
    await runWorkerJob(batchId)

    const notices = await noticesOf([BRAND_1, BRAND_2, BRAND_3])
    expect(notices).toHaveLength(3)
    const byBrand = new Map(notices.map((n) => [n.brandId, n]))
    expect({
      b1: [
        Number(byBrand.get(BRAND_1)!.amount),
        Number(byBrand.get(BRAND_1)!.balanceAfter),
        byBrand.get(BRAND_1)!.movementKey,
        byBrand.get(BRAND_1)!.status,
      ],
      b2: [
        Number(byBrand.get(BRAND_2)!.amount),
        Number(byBrand.get(BRAND_2)!.balanceAfter),
        byBrand.get(BRAND_2)!.movementKey,
        byBrand.get(BRAND_2)!.status,
      ],
      b3: [
        Number(byBrand.get(BRAND_3)!.amount),
        Number(byBrand.get(BRAND_3)!.balanceAfter),
        byBrand.get(BRAND_3)!.movementKey,
        byBrand.get(BRAND_3)!.status,
      ],
    }).toEqual({
      b1: [20, 30, `gift-batch:${batchId}:${BRAND_1}`, TokenGiftNoticeStatus.PENDIENTE],
      b2: [20, 20, `gift-batch:${batchId}:${BRAND_2}`, TokenGiftNoticeStatus.PENDIENTE],
      b3: [20, 25, `gift-batch:${batchId}:${BRAND_3}`, TokenGiftNoticeStatus.PENDIENTE],
    })
    for (const notice of notices) {
      const json = JSON.stringify(notice)
      expect(json).not.toContain('motivo lote secreto')
      expect(json).not.toContain(SUPERADMIN_ID)
    }
  })

  it('CA7 — movement fails: attempting to debit more than the gift balance answers 400 INSUFFICIENT_GIFT_TOKENS and writes no notice', async () => {
    // R15: red when a notice is written before debitGiftTokens validates the gift balance.
    await seedTknWallet(BRAND_1, 10)

    const res = await debitGift({
      amount: 25,
      reason: 'too much',
      idempotencyKey: 'loc254-k5',
    })

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body.code).toBe('INSUFFICIENT_GIFT_TOKENS')
    expect(Number((await tokenWallet(BRAND_1))!.giftTokens)).toBe(10)
    expect(await noticesOf([BRAND_1])).toHaveLength(0)
  })

  it('Atomicity: forcing the TokenGiftNotice write to fail rolls back the 20 gift credit, transaction, and audit on single gift and debit, and a retry applies once', async () => {
    // R15: red when the notice is written outside the movement transaction: the gift remains credited without a notice.
    failNextWriteOf(TokenGiftNotice)
    const body = { amount: 20, reason: 'atomic gift', idempotencyKey: 'loc254-k6' }

    const failedGift = await gift(body)

    const walletAfterFail = (await tokenWallet(BRAND_1))!
    expect([Number(walletAfterFail.balance), Number(walletAfterFail.giftTokens)]).toEqual([0, 0])
    expect(await movementsOf(BRAND_1)).toHaveLength(0)
    expect(await auditsOf(walletAfterFail.id)).toHaveLength(0)
    expect(await noticesOf([BRAND_1])).toHaveLength(0)
    expect(failedGift.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)

    const retriedGift = await gift(body)
    expect(retriedGift.status).toBe(HttpStatus.CREATED)
    const walletAfterRetry = (await tokenWallet(BRAND_1))!
    expect([Number(walletAfterRetry.balance), Number(walletAfterRetry.giftTokens)]).toEqual([
      20, 20,
    ])
    expect(await movementsOf(BRAND_1)).toHaveLength(1)
    expect(await auditsOf(walletAfterRetry.id)).toHaveLength(1)
    expect(await noticesOf([BRAND_1])).toHaveLength(1)

    jest.restoreAllMocks()
    failNextWriteOf(TokenGiftNotice)
    const debitBody = { amount: 5, reason: 'atomic debit', idempotencyKey: 'loc254-k7' }
    const failedDebit = await debitGift(debitBody)
    expect(failedDebit.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect(Number((await tokenWallet(BRAND_1))!.giftTokens)).toBe(20)
    expect(await noticesOf([BRAND_1])).toHaveLength(1)

    jest.restoreAllMocks()
    const retriedDebit = await debitGift(debitBody)
    expect(retriedDebit.status).toBe(HttpStatus.CREATED)
    expect(Number((await tokenWallet(BRAND_1))!.giftTokens)).toBe(15)
    expect(await noticesOf([BRAND_1])).toHaveLength(2)
  })

  it('CA3 — in history: after gifting 20 with reason "prueba", GET /v1/token-wallet/movements as brand admin shows the 20 gift credit without reason or author', async () => {
    // R15: red when GET /v1/token-wallet/movements omits the gift credit or leaks the admin reason/author.
    const giftRes = await gift({ amount: 20, reason: 'prueba', idempotencyKey: 'loc254-k8' })
    expect(giftRes.status).toBe(HttpStatus.CREATED)

    const histRes = await getMovements(BRAND_1, brandAdmin)
    expect(histRes.status).toBe(HttpStatus.OK)
    expect(histRes.body.data).toHaveLength(1)
    expect(histRes.body.data[0]).toMatchObject({
      type: TransactionType.CREDIT,
      origin: 'gift',
      tokenSplit: null,
      amount: 20,
      balanceAfter: 20,
    })
    const serialized = JSON.stringify(histRes.body)
    expect(serialized).not.toContain('prueba')
    expect(serialized).not.toContain(SUPERADMIN_ID)
  })

  it('Migration AddTokenGiftNotices1794350000000 runs up, enforces unique movementKey, and runs down cleanly on a disposable database', async () => {
    // R15: red when up omits UQ_token_gift_notices_movement_key or down fails to drop token_gift_notices.
    const migration = new AddTokenGiftNotices1794350000000()
    const usedDb = await withDisposableDatabase(adminDataSource, async (runner) => {
      await runner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"')
      await migration.up(runner)

      await runner.query(
        `INSERT INTO "token_gift_notices" ("brandId", "amount", "balanceAfter", "movementKey")
         VALUES ($1, $2, $3, $4)`,
        [BRAND_1, 20, 20, 'admin:mig-k1'],
      )
      const [inserted] = await runner.query(
        `SELECT "brandId", "amount", "balanceAfter", "movementKey", "status" FROM "token_gift_notices"`,
      )
      expect(inserted).toEqual({
        brandId: BRAND_1,
        amount: '20.00',
        balanceAfter: '20.00',
        movementKey: 'admin:mig-k1',
        status: 'pendiente',
      })

      await runner.startTransaction()
      await expect(
        runner.query(
          `INSERT INTO "token_gift_notices" ("brandId", "amount", "balanceAfter", "movementKey")
           VALUES ($1, $2, $3, $4)`,
          [BRAND_1, 20, 40, 'admin:mig-k1'],
        ),
      ).rejects.toThrow()
      await runner.rollbackTransaction()

      await migration.down(runner)
      const tables = await runner.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'token_gift_notices'`,
      )
      expect(tables).toHaveLength(0)

      await migration.up(runner)
      const recreated = await runner.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = 'token_gift_notices'`,
      )
      expect(recreated).toHaveLength(1)
    })
    expect(await databaseExists(adminDataSource, usedDb)).toBe(false)
  }, 30000)
})
