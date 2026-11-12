/**
 * Token wallet movements for the brand (`GET /v1/token-wallet/movements`) and redaction of admin
 * reason and author on `GET /wallet/:id/transactions` over HTTP against PostgreSQL.
 * R6: one responsibility, the brand token movement history endpoint and member transaction
 * redaction behind one test app and database.
 */
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AddTokenGiftNotices1794350000000 } from '../migrations/1794350000000-AddTokenGiftNotices'
import { AdminTokenGiftController } from '../src/admin/admin-token-gift.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { TokenGiftNotice } from '../src/wallet/entities/token-gift-notice.entity'
import { Wallet } from '../src/wallet/entities/wallet.entity'
import { TokenOrigin } from '../src/wallet/token-origin'
import { TokenWalletController } from '../src/wallet/token-wallet.controller'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { WalletController } from '../src/wallet/wallet.controller'
import { WalletService } from '../src/wallet/wallet.service'
import { unknownServiceKeys } from './support/service-credential.double'
import { startUpstream, Upstream } from './support/token-debit.fixture'

dotenvConfig({ path: '.env' })

const [BRAND_A, BRAND_B, BRAND_EMPTY] = [
  'a2490000-0000-4000-8000-0000000000a1',
  'a2490000-0000-4000-8000-0000000000b2',
  'a2490000-0000-4000-8000-0000000000c3',
]
const [MEMBER_A_ID, MEMBER_B_ID, SUPERADMIN_ID] = [
  'member-brand-a-loc249',
  'member-brand-b-loc249',
  'superadmin-loc249',
]
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc249-jwt-secret', 'e2e-loc249-server-token']

function platformDirectory(): Upstream['reply'] {
  return (path, res) => {
    const rows: { user: string; rol: string }[] = []
    if (
      path.includes(encodeURIComponent(BRAND_A)) ||
      path.includes(encodeURIComponent(BRAND_EMPTY))
    ) {
      rows.push({ user: MEMBER_A_ID, rol: 'admin' })
    }
    if (path.includes(encodeURIComponent(BRAND_B))) {
      rows.push({ user: MEMBER_B_ID, rol: 'admin' })
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: rows }))
  }
}

describe('Brand token wallet movements and member transaction redaction (PostgreSQL)', () => {
  const envSnapshot = { ...process.env }
  let platform: Upstream
  let app: INestApplication
  let dataSource: DataSource
  let tokens: TokenWalletService
  let memberA = ''
  let memberB = ''
  let superAdmin = ''

  const http = () => request(app.getHttpServer())
  const getMovements = (query: string, token = memberA) =>
    http().get(`/v1/token-wallet/movements${query}`).set('Authorization', `Bearer ${token}`)
  const getWalletTransactions = (walletId: string, token = memberA) =>
    http().get(`/wallet/${walletId}/transactions`).set('Authorization', `Bearer ${token}`)

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    const brands = [BRAND_A, BRAND_B, BRAND_EMPTY]
    await dataSource.query('DELETE FROM token_gift_notices WHERE "brandId" = ANY($1)', [brands])
    await dataSource.query(
      'DELETE FROM audit_log WHERE "entityType" = \'wallet\' AND "entityId" IN (SELECT id::text FROM wallets WHERE "brandId" = ANY($1))',
      [brands],
    )
    await dataSource.query('DELETE FROM transactions WHERE "brandId" = ANY($1)', [brands])
    await dataSource.query('DELETE FROM wallets WHERE "brandId" = ANY($1)', [brands])
  }

  const seedThreeMovements = async () => {
    const giftRes = await http()
      .post(`/admin/token-wallets/${BRAND_A}/gifts`)
      .set('Authorization', `Bearer ${superAdmin}`)
      .send({ amount: 20, reason: 'prueba', idempotencyKey: 'gift-one' })
    expect(giftRes.status).toBe(HttpStatus.CREATED)
    const walletId: string = giftRes.body.data.wallet.id

    await tokens.creditTokens(
      walletId,
      100,
      TokenOrigin.PURCHASED,
      {
        brandId: BRAND_A,
        category: 'token_package',
        description: 'Package 100',
        referenceType: 'payment',
        referenceId: 'payment-one',
        metadata: { packageId: 'pkg-100' },
      },
      'pkg-one',
    )
    await tokens.debitTokens(
      walletId,
      30,
      { brandId: BRAND_A },
      {
        category: 'generation',
        description: 'Video generation',
        referenceType: 'token_debit',
        referenceId: 'gen-one',
        metadata: { userId: MEMBER_A_ID },
      },
      'debit-one',
    )
    return walletId
  }

  beforeAll(async () => {
    platform = await startUpstream(platformDirectory())
    Object.assign(process.env, {
      JWT_SECRET,
      ACCESS_SERVER,
      SERVICE_PLATFORM: platform.url,
    })
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [Wallet, Transaction, AuditLog, TokenGiftNotice],
      synchronize: false,
    })
    await dataSource.initialize()
    const hasNotices = await dataSource.query(
      `SELECT 1 FROM information_schema.tables WHERE table_name = 'token_gift_notices'`,
    )
    if (!hasNotices.length) {
      const runner = dataSource.createQueryRunner()
      try {
        await new AddTokenGiftNotices1794350000000().up(runner)
      } finally {
        await runner.release()
      }
    }

    const jwtService = new JwtService({ secret: JWT_SECRET })
    memberA = jwtService.sign({ id: MEMBER_A_ID, isSuperAdmin: false, brand: BRAND_A })
    memberB = jwtService.sign({ id: MEMBER_B_ID, isSuperAdmin: false, brand: BRAND_B })
    superAdmin = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })

    const repo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminTokenGiftController, TokenWalletController, WalletController],
      providers: [
        AuditService,
        WalletService,
        TokenWalletService,
        ClientPlatformService,
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: JwtService, useValue: jwtService },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        ...[Wallet, Transaction, AuditLog, TokenGiftNotice].flatMap((e) => [
          repo(e, 'DBWrite'),
          repo(e, 'DBRead'),
        ]),
        // R17: these routes use @RequireSuperAdmin or brand membership, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
    tokens = app.get(TokenWalletService)
  })

  beforeEach(async () => {
    platform.mode = 'ok'
    platform.reply = platformDirectory()
    await clean()
  })

  afterAll(async () => {
    await clean()
    await app?.close()
    await platform?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it('CA3 returns the three movements newest to oldest with their type, credit origin, amount, and balanceAfter', async () => {
    // R15: red when listMovements orders ASC or drops balanceAfter/origin mapping.
    await seedThreeMovements()

    const res = await getMovements(`?brandId=${BRAND_A}`)

    expect(res.status).toBe(HttpStatus.OK)
    expect(res.body.meta).toEqual({ total: 3, page: 1, limit: 20, totalPages: 1 })
    expect(res.body.data).toHaveLength(3)
    const [debit, purchase, gift] = res.body.data
    expect(debit).toMatchObject({
      type: 'debit',
      origin: null,
      amount: 30,
      balanceAfter: 90,
    })
    expect(purchase).toMatchObject({
      type: 'credit',
      origin: 'purchased',
      tokenSplit: null,
      amount: 100,
      balanceAfter: 120,
    })
    expect(gift).toMatchObject({
      type: 'credit',
      origin: 'gift',
      tokenSplit: null,
      amount: 20,
      balanceAfter: 20,
    })
  })

  it('CA3 omits the gift reason, author, description, metadata, referenceType, and referenceId from the movement response', async () => {
    // R15: red when listMovements returns the raw Transaction entity: "prueba" and SUPERADMIN_ID leak in the response.
    await seedThreeMovements()

    const res = await getMovements(`?brandId=${BRAND_A}`)

    expect(res.status).toBe(HttpStatus.OK)
    const serialized = JSON.stringify(res.body)
    expect(serialized).not.toContain('prueba')
    expect(serialized).not.toContain(SUPERADMIN_ID)
    for (const row of res.body.data) {
      expect(row).not.toHaveProperty('description')
      expect(row).not.toHaveProperty('metadata')
      expect(row).not.toHaveProperty('referenceType')
      expect(row).not.toHaveProperty('referenceId')
      expect(Object.keys(row).sort()).toEqual([
        'amount',
        'balanceAfter',
        'createdAt',
        'id',
        'origin',
        'tokenSplit',
        'type',
      ])
    }
  })

  it('CA3 includes the debit breakdown by origin (gift: 20, purchased: 10, dropi: 0) on the debit movement', async () => {
    // R15: red when toMovementView ignores tx.metadata.tokenSplit and returns tokenSplit: null on debits.
    await seedThreeMovements()

    const res = await getMovements(`?brandId=${BRAND_A}`)

    expect(res.status).toBe(HttpStatus.OK)
    const [debit] = res.body.data
    expect(debit.tokenSplit).toEqual({ gift: 20, purchased: 10, dropi: 0 })
  })

  it('filters movements by type and date range without dropping the lower date bound', async () => {
    // R15: red when dateFrom is overwritten by dateTo or type filter is ignored: out-of-range rows are returned.
    const walletId = await seedThreeMovements()
    const rows = await dataSource
      .getRepository(Transaction)
      .find({ where: { walletId }, order: { createdAt: 'ASC' } })
    await dataSource
      .getRepository(Transaction)
      .update({ id: rows[0].id }, { createdAt: new Date('2026-01-10T10:00:00.000Z') })
    await dataSource
      .getRepository(Transaction)
      .update({ id: rows[1].id }, { createdAt: new Date('2026-02-15T10:00:00.000Z') })
    await dataSource
      .getRepository(Transaction)
      .update({ id: rows[2].id }, { createdAt: new Date('2026-03-20T10:00:00.000Z') })

    const creditsOnly = await getMovements(`?brandId=${BRAND_A}&type=credit`)
    expect(creditsOnly.status).toBe(HttpStatus.OK)
    expect(creditsOnly.body.data.map((r: { origin: string }) => r.origin)).toEqual([
      'purchased',
      'gift',
    ])

    const febWindow = await getMovements(
      `?brandId=${BRAND_A}&dateFrom=2026-02-01T00:00:00.000Z&dateTo=2026-02-28T23:59:59.000Z`,
    )
    expect(febWindow.status).toBe(HttpStatus.OK)
    expect(febWindow.body.data).toHaveLength(1)
    expect(febWindow.body.data[0]).toMatchObject({ origin: 'purchased', amount: 100 })
  })

  it('returns 403 when an admin of another brand asks for this brand movements', async () => {
    // R15: red when GET /v1/token-wallet/movements skips assertBrandAccess: memberB gets 200 with brand A movements.
    await seedThreeMovements()

    const res = await getMovements(`?brandId=${BRAND_A}`, memberB)

    expect(res.status).toBe(HttpStatus.FORBIDDEN)
  })

  it('omits description, metadata, and the gift referenceId on GET /wallet/:id/transactions for a brand member', async () => {
    // R15: red when GET /wallet/:id/transactions stops redacting for non-privileged callers: member sees metadata and description.
    const walletId = await seedThreeMovements()

    const memberRes = await getWalletTransactions(walletId, memberA)

    expect(memberRes.status).toBe(HttpStatus.OK)
    expect(memberRes.body.data).toHaveLength(3)
    for (const tx of memberRes.body.data) {
      expect(tx).not.toHaveProperty('description')
      expect(tx).not.toHaveProperty('metadata')
    }
    const memberGift = memberRes.body.data.find(
      (tx: { category: string }) => tx.category === 'gift',
    )
    expect(memberGift).toBeDefined()
    expect(memberGift).not.toHaveProperty('referenceId')
    const memberJson = JSON.stringify(memberRes.body)
    expect(memberJson).not.toContain('prueba')
    expect(memberJson).not.toContain(SUPERADMIN_ID)
  })

  it('returns description, metadata, and referenceId on GET /wallet/:id/transactions for a super admin', async () => {
    // R15: red when GET /wallet/:id/transactions redacts all callers regardless of isPrivilegedCaller.
    const walletId = await seedThreeMovements()

    const adminRes = await getWalletTransactions(walletId, superAdmin)

    expect(adminRes.status).toBe(HttpStatus.OK)
    const adminGift = adminRes.body.data.find((tx: { category: string }) => tx.category === 'gift')
    expect(adminGift).toMatchObject({
      description: 'prueba',
      referenceId: SUPERADMIN_ID,
      metadata: { authorId: SUPERADMIN_ID, reason: 'prueba' },
    })
  })

  it('returns 200 with an empty list for a brand without a TKN wallet and creates no wallet', async () => {
    // R15: red when listMovements calls getOrCreate instead of findTokenWalletId: a TKN wallet row is created.
    const res = await getMovements(`?brandId=${BRAND_EMPTY}`, memberA)

    expect(res.status).toBe(HttpStatus.OK)
    expect(res.body).toEqual({
      data: [],
      meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
    })
    const count = await dataSource
      .getRepository(Wallet)
      .countBy({ brandId: BRAND_EMPTY, currency: 'TKN' })
    expect(count).toBe(0)
  })

  it('rejects limit=500 above the maximum with 400 INVALID_REQUEST', async () => {
    // R15: red when ListTokenWalletMovementsQueryDto drops @Max(100) on limit.
    const res = await getMovements(`?brandId=${BRAND_A}&limit=500`, memberA)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body.code).toBe('INVALID_REQUEST')
  })

  it.each([
    ['limit=1e-7 (exponent form)', `limit=1e-7`],
    ['limit=abc (string)', `limit=abc`],
    ['limit=null', `limit=null`],
    ['limit=999999999999999 (column max)', `limit=999999999999999`],
    ['page=0 (below minimum)', `page=0`],
    ['page=1e-7 (exponent form)', `page=1e-7`],
    ['type=invalid', `type=invalid`],
    ['dateFrom=not-a-date', `dateFrom=not-a-date`],
    ['dateTo=not-a-date', `dateTo=not-a-date`],
  ])('rejects invalid query %s with 400 INVALID_REQUEST and never 500', async (_label, query) => {
    // R15: red when ListTokenWalletMovementsQueryDto drops its @IsInt, @Min, @IsEnum, or @IsDateString validators.
    const res = await getMovements(`?brandId=${BRAND_A}&${query}`, memberA)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body.code).toBe('INVALID_REQUEST')
  })

  it('answers 503 BRAND_LOOKUP_UNAVAILABLE when platform accepts the connection and never responds', async () => {
    // R15: red when ClientPlatformService drops its AbortSignal.timeout or maps a timeout to 403 instead of 503.
    platform.mode = 'hang'

    const started = Date.now()
    const res = await getMovements(`?brandId=${BRAND_A}`, memberA)
    const elapsed = Date.now() - started

    expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(res.body.code).toBe('BRAND_LOOKUP_UNAVAILABLE')
    expect(elapsed).toBeGreaterThanOrEqual(9_500)
    expect(elapsed).toBeLessThan(12_500)
  }, 15_000)
})
