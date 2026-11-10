// R6: One responsibility, the brand token wallet birth, backfill, and GET /wallet e2e scenarios sharing one Nest app and PostgreSQL connection.
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource, In } from 'typeorm'

import { AdminTokenGiftController } from '../src/admin/admin-token-gift.controller'
import { AdminController } from '../src/admin/admin.controller'
import { MAX_MONEY_AMOUNT } from '../src/admin/dto/money-input'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { BrandLegalDocument } from '../src/billing-profile/entities/brandLegalDocument.entity'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { CreditService } from '../src/credit/credit.service'
import { Payment } from '../src/payment/entities/payment.entity'
import { ProviderConfig } from '../src/provider/entities/providerConfig.entity'
import { Refund } from '../src/refund/entities/refund.entity'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import { runBackfillTokenWalletsCli } from '../src/wallet/backfill-token-wallets'
import { Wallet, WalletProvider, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { TokenWalletController } from '../src/wallet/token-wallet.controller'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { WalletController } from '../src/wallet/wallet.controller'
import { WalletService } from '../src/wallet/wallet.service'
import { unknownServiceKeys } from './support/service-credential.double'

dotenvConfig({ path: '.env' })

const BRAND_BIRTH = 'b2510000-0000-4000-8000-000000000011'
const BRAND_EXISTING_COP = 'b2510000-0000-4000-8000-000000000012'
const BRAND_RACE = 'b2510000-0000-4000-8000-000000000013'
const BRAND_BF_1 = 'b2510000-0000-4000-8000-000000000021'
const BRAND_BF_2 = 'b2510000-0000-4000-8000-000000000022'
const BRAND_BF_3 = 'b2510000-0000-4000-8000-000000000023'
const BRAND_BF_WITH_TKN_1 = 'b2510000-0000-4000-8000-000000000024'
const BRAND_BF_WITH_TKN_2 = 'b2510000-0000-4000-8000-000000000025'
const BRAND_HOME = 'b2510000-0000-4000-8000-000000000031'
const BRAND_SEC = 'b2510000-0000-4000-8000-000000000041'
const BRAND_SUPERADMIN_BAL = 'b2510000-0000-4000-8000-000000000042'
const BRAND_GIFT = 'b2510000-0000-4000-8000-000000000051'

const BACKFILL_BRANDS = [
  BRAND_BF_1,
  BRAND_BF_2,
  BRAND_BF_3,
  BRAND_BF_WITH_TKN_1,
  BRAND_BF_WITH_TKN_2,
]

const ALL_BRANDS = [
  BRAND_BIRTH,
  BRAND_EXISTING_COP,
  BRAND_RACE,
  ...BACKFILL_BRANDS,
  BRAND_HOME,
  BRAND_SEC,
  BRAND_SUPERADMIN_BAL,
  BRAND_GIFT,
]

const USER_OWNER = 'c2510000-0000-4000-8000-000000000001'
const SUPERADMIN_ID = 'c2510000-0000-4000-8000-000000000002'
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc251-jwt-secret', 'e2e-loc251-server-token']

describe('Brand token wallet at brand birth, backfill command, and GET /wallet exclusion (PostgreSQL, LOC-251)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let superAdminToken = ''
  let memberToken = ''
  let tempDir = ''

  const http = () => request(app.getHttpServer())
  const platformCreateWalletBody = (brandId: string, overrides: Record<string, unknown> = {}) => ({
    brandId,
    userId: USER_OWNER,
    provider: 'internal',
    currency: 'COP',
    label: 'Wallet principal',
    balance: 0,
    adminUserId: 'system',
    ...overrides,
  })

  const seedBackfillScenario = async () => {
    const walletRepo = dataSource.getRepository(Wallet)
    await walletRepo.save([
      walletRepo.create({
        brandId: BRAND_BF_1,
        userId: USER_OWNER,
        provider: WalletProvider.INTERNAL,
        currency: 'COP',
        balance: 0,
        status: WalletStatus.ACTIVE,
      }),
      walletRepo.create({
        brandId: BRAND_BF_2,
        userId: USER_OWNER,
        provider: WalletProvider.DROPI,
        currency: 'COP',
        balance: 100,
        status: WalletStatus.ACTIVE,
      }),
      walletRepo.create({
        brandId: BRAND_BF_WITH_TKN_1,
        userId: USER_OWNER,
        provider: WalletProvider.INTERNAL,
        currency: 'COP',
        balance: 0,
        status: WalletStatus.ACTIVE,
      }),
      walletRepo.create({
        brandId: BRAND_BF_WITH_TKN_1,
        userId: USER_OWNER,
        provider: WalletProvider.INTERNAL,
        currency: 'TKN',
        balance: 10,
        giftTokens: 10,
        status: WalletStatus.ACTIVE,
      }),
      walletRepo.create({
        brandId: BRAND_BF_WITH_TKN_2,
        userId: USER_OWNER,
        provider: WalletProvider.INTERNAL,
        currency: 'TKN',
        balance: 0,
        status: WalletStatus.ACTIVE,
      }),
    ])
    const brandsFile = join(tempDir, 'platform-brands.txt')
    writeFileSync(brandsFile, [BRAND_BF_1, BRAND_BF_3, BRAND_BF_WITH_TKN_1].join('\n'), 'utf8')
    return { walletRepo, brandsFile }
  }

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    await dataSource.query(
      `DELETE FROM audit_log WHERE "entityType" = 'wallet' AND "entityId" IN (SELECT id::text FROM wallets WHERE "brandId" = ANY($1))`,
      [ALL_BRANDS],
    )
    await dataSource.getRepository(Transaction).delete({ brandId: In(ALL_BRANDS) })
    await dataSource.getRepository(Wallet).delete({ brandId: In(ALL_BRANDS) })
  }

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'loc251-e2e-'))
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER })
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [
        Payment,
        Refund,
        Subscription,
        SubscriptionEvent,
        BrandLegalDocument,
        Wallet,
        WalletBalanceSnapshot,
        ProviderConfig,
        Transaction,
        AuditLog,
      ],
      synchronize: false,
    })
    await dataSource.initialize()

    const jwtService = new JwtService({ secret: JWT_SECRET })
    superAdminToken = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })
    memberToken = jwtService.sign({ id: USER_OWNER, isSuperAdmin: false, brand: null })

    const repo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })

    const moduleRef = await Test.createTestingModule({
      controllers: [
        AdminController,
        AdminTokenGiftController,
        WalletController,
        TokenWalletController,
      ],
      providers: [
        AuditService,
        WalletService,
        TokenWalletService,
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: JwtService, useValue: jwtService },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        ...[Subscription, Payment, Wallet, ProviderConfig, Transaction, AuditLog].flatMap((e) => [
          repo(e, 'DBWrite'),
          repo(e, 'DBRead'),
        ]),
        repo(WalletBalanceSnapshot, 'DBRead'),
        // R17: AdminController requires CreditService in its constructor; wallet routes do not call it.
        { provide: CreditService, useValue: {} },
        // R17: External HTTP to backend-platform is out of scope; brand access is granted for the test brands.
        {
          provide: ClientPlatformService,
          useValue: {
            canViewBrandCredit: jest.fn(async (_userId: string, brandId: string) =>
              ALL_BRANDS.includes(brandId),
            ),
          },
        },
        // R17: Routes under test use @RequireSuperAdmin or brand membership, not granular role slugs.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  beforeEach(clean)

  afterAll(async () => {
    await clean()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    process.env = envSnapshot
  })

  it('CA5 opens both the money wallet and the TKN wallet in 0 and active when a brand is born with the server token', async () => {
    // R15: red when createWallet stops calling tokenWallets.getOrCreate: the TKN wallet is missing.
    const res = await http()
      .post('/admin/wallets')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
      .send(platformCreateWalletBody(BRAND_BIRTH))

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body.data).toMatchObject({
      brandId: BRAND_BIRTH,
      userId: USER_OWNER,
      provider: WalletProvider.INTERNAL,
      currency: 'COP',
      status: WalletStatus.ACTIVE,
    })
    expect(Number(res.body.data.balance)).toBe(0)

    const wallets = await dataSource.getRepository(Wallet).findBy({ brandId: BRAND_BIRTH })
    expect(wallets).toHaveLength(2)
    const tkn = wallets.find((w) => w.currency === 'TKN')
    expect(tkn).toBeDefined()
    expect({
      provider: tkn!.provider,
      userId: tkn!.userId,
      status: tkn!.status,
      balance: Number(tkn!.balance),
      giftTokens: Number(tkn!.giftTokens),
      purchasedTokens: Number(tkn!.purchasedTokens),
      dropiTokens: Number(tkn!.dropiTokens),
    }).toEqual({
      provider: WalletProvider.INTERNAL,
      userId: USER_OWNER,
      status: WalletStatus.ACTIVE,
      balance: 0,
      giftTokens: 0,
      purchasedTokens: 0,
      dropiTokens: 0,
    })

    const txs = await dataSource.getRepository(Transaction).findBy({ brandId: BRAND_BIRTH })
    expect(txs).toHaveLength(0)
  })

  it('CA5 opens the TKN wallet and preserves the duplicate-money-wallet response when the brand already had its COP wallet', async () => {
    const walletRepo = dataSource.getRepository(Wallet)
    const existingCop = await walletRepo.save(
      walletRepo.create({
        brandId: BRAND_EXISTING_COP,
        userId: USER_OWNER,
        provider: WalletProvider.INTERNAL,
        currency: 'COP',
        balance: 50000,
        status: WalletStatus.ACTIVE,
      }),
    )

    const res = await http()
      .post('/admin/wallets')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
      .send(platformCreateWalletBody(BRAND_EXISTING_COP))

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body).toEqual({
      error: 'Ya existe una wallet internal/COP para esta marca',
    })

    const wallets = await walletRepo.findBy({ brandId: BRAND_EXISTING_COP })
    expect(wallets).toHaveLength(2)
    const cop = wallets.find((w) => w.currency === 'COP')!
    const tkn = wallets.find((w) => w.currency === 'TKN')!
    expect([cop.id, Number(cop.balance)]).toEqual([existingCop.id, 50000])
    expect([tkn.provider, tkn.status, Number(tkn.balance)]).toEqual([
      WalletProvider.INTERNAL,
      WalletStatus.ACTIVE,
      0,
    ])
  })

  it('CA5 creates a single TKN wallet when POST /admin/wallets and GET /token-wallet race for the same brand', async () => {
    const [adminRes, readRes] = await Promise.all([
      http()
        .post('/admin/wallets')
        .set('Authorization', `Bearer ${ACCESS_SERVER}`)
        .send(platformCreateWalletBody(BRAND_RACE)),
      http()
        .get(`/token-wallet?brandId=${BRAND_RACE}`)
        .set('Authorization', `Bearer ${memberToken}`),
    ])

    expect(adminRes.status).toBe(HttpStatus.CREATED)
    expect(readRes.status).toBe(HttpStatus.OK)
    expect(readRes.body.data).toMatchObject({
      brandId: BRAND_RACE,
      currency: 'TKN',
      status: WalletStatus.ACTIVE,
      balance: 0,
    })

    const tknWallets = await dataSource
      .getRepository(Wallet)
      .findBy({ brandId: BRAND_RACE, currency: 'TKN' })
    expect(tknWallets).toHaveLength(1)
    expect(tknWallets[0].id).toBe(readRes.body.data.id)
  })

  it('lists the 3 brands without TKN and opens nothing when the backfill command runs without --apply', async () => {
    // R15: red when backfillTokenWallets writes without --apply: the dry-run creates 3 TKN wallets.
    const { walletRepo, brandsFile } = await seedBackfillScenario()

    const dryRunLines: string[] = []
    const dryRun = await runBackfillTokenWalletsCli(
      ['--brands-file', brandsFile],
      () => dataSource,
      (line) => dryRunLines.push(line),
    )

    expect(await walletRepo.countBy({ brandId: In(BACKFILL_BRANDS), currency: 'TKN' })).toBe(2)
    expect(dryRun.apply).toBe(false)
    expect(dryRun.missingBrandIds.filter((id) => BACKFILL_BRANDS.includes(id))).toEqual([
      BRAND_BF_1,
      BRAND_BF_2,
      BRAND_BF_3,
    ])
    expect(dryRun.createdBrandIds).toEqual([])
  })

  it('opens 3 new TKN wallets on the first --apply run and none on the second', async () => {
    const { walletRepo, brandsFile } = await seedBackfillScenario()
    const countTkn = () => walletRepo.countBy({ brandId: In(BACKFILL_BRANDS), currency: 'TKN' })

    const firstApply = await runBackfillTokenWalletsCli(
      ['--brands-file', brandsFile, '--apply'],
      () => dataSource,
      () => undefined,
    )
    expect(firstApply.apply).toBe(true)
    expect(firstApply.createdBrandIds.filter((id) => BACKFILL_BRANDS.includes(id))).toEqual([
      BRAND_BF_1,
      BRAND_BF_2,
      BRAND_BF_3,
    ])
    expect(await countTkn()).toBe(5)

    for (const brandId of [BRAND_BF_1, BRAND_BF_2, BRAND_BF_3]) {
      const created = await walletRepo.findOneByOrFail({ brandId, currency: 'TKN' })
      expect([
        created.provider,
        created.status,
        Number(created.balance),
        Number(created.giftTokens),
        Number(created.purchasedTokens),
        Number(created.dropiTokens),
      ]).toEqual([WalletProvider.INTERNAL, WalletStatus.ACTIVE, 0, 0, 0, 0])
    }

    const secondApply = await runBackfillTokenWalletsCli(
      ['--brands-file', brandsFile, '--apply'],
      () => dataSource,
      () => undefined,
    )
    expect(secondApply.missingBrandIds.filter((id) => BACKFILL_BRANDS.includes(id))).toEqual([])
    expect(secondApply.createdBrandIds.filter((id) => BACKFILL_BRANDS.includes(id))).toEqual([])
    expect(await countTkn()).toBe(5)
  })

  it('excludes the TKN wallet from GET /wallet while returning the money wallet for home', async () => {
    const walletRepo = dataSource.getRepository(Wallet)
    await walletRepo.save([
      walletRepo.create({
        brandId: BRAND_HOME,
        userId: USER_OWNER,
        provider: WalletProvider.INTERNAL,
        currency: 'COP',
        balance: 0,
        status: WalletStatus.ACTIVE,
      }),
      walletRepo.create({
        brandId: BRAND_HOME,
        userId: USER_OWNER,
        provider: WalletProvider.INTERNAL,
        currency: 'TKN',
        balance: 0,
        status: WalletStatus.ACTIVE,
      }),
    ])

    const listRes = await http()
      .get(`/wallet?brandId=${BRAND_HOME}`)
      .set('Authorization', `Bearer ${memberToken}`)
    expect(listRes.status).toBe(HttpStatus.OK)
    expect(listRes.body.data).toHaveLength(1)
    expect(listRes.body.data[0]).toMatchObject({
      brandId: BRAND_HOME,
      currency: 'COP',
      status: WalletStatus.ACTIVE,
    })
  })

  it('rejects POST /admin/wallets with 400 when the server token sends balance 1000 and creates no wallets, while allowing super admin session balance', async () => {
    // R15: red when createWallet accepts a non-zero balance with ACCESS_SERVER: it answers 201 and creates wallets.
    const serverRes = await http()
      .post('/admin/wallets')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
      .send(platformCreateWalletBody(BRAND_SEC, { balance: 1000 }))

    expect(serverRes.status).toBe(HttpStatus.BAD_REQUEST)
    expect(serverRes.body.code).toBe('SERVER_INITIAL_BALANCE_FORBIDDEN')
    expect(await dataSource.getRepository(Wallet).countBy({ brandId: BRAND_SEC })).toBe(0)

    const superAdminRes = await http()
      .post('/admin/wallets')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(platformCreateWalletBody(BRAND_SUPERADMIN_BAL, { balance: 1000 }))
    expect(superAdminRes.status).toBe(HttpStatus.CREATED)
    expect(Number(superAdminRes.body.data.balance)).toBe(1000)
  })

  it('rejects POST /admin/wallets with 400 when brandId is not a UUID or balance has an invalid shape, creating nothing', async () => {
    for (const badBody of [
      platformCreateWalletBody('x'),
      platformCreateWalletBody(1e-7 as unknown as string),
      platformCreateWalletBody(null as unknown as string),
      platformCreateWalletBody('a'.repeat(120)),
      platformCreateWalletBody(BRAND_SEC, { balance: 1e-7 }),
      platformCreateWalletBody(BRAND_SEC, { balance: '1000' }),
      platformCreateWalletBody(BRAND_SEC, { balance: null }),
      platformCreateWalletBody(BRAND_SEC, { balance: MAX_MONEY_AMOUNT + 1 }),
    ]) {
      const res = await http()
        .post('/admin/wallets')
        .set('Authorization', `Bearer ${ACCESS_SERVER}`)
        .send(badBody)
      expect(res.status).toBe(HttpStatus.BAD_REQUEST)
      expect(res.body.code).toBe('INVALID_REQUEST')
    }

    expect(await dataSource.getRepository(Wallet).countBy({ brandId: BRAND_SEC })).toBe(0)
    expect(await dataSource.getRepository(Wallet).countBy({ brandId: 'x' })).toBe(0)
  })

  it('rejects POST /admin/wallets with 401 when called without credentials and creates nothing', async () => {
    const unauthRes = await http().post('/admin/wallets').send(platformCreateWalletBody(BRAND_SEC))
    expect(unauthRes.status).toBe(HttpStatus.UNAUTHORIZED)
    expect(await dataSource.getRepository(Wallet).countBy({ brandId: BRAND_SEC })).toBe(0)
  })

  it('rejects POST /admin/wallets with 403 when called with a non-super-admin session and creates nothing', async () => {
    const forbiddenRes = await http()
      .post('/admin/wallets')
      .set('Authorization', `Bearer ${memberToken}`)
      .send(platformCreateWalletBody(BRAND_SEC))
    expect(forbiddenRes.status).toBe(HttpStatus.FORBIDDEN)
    expect(await dataSource.getRepository(Wallet).countBy({ brandId: BRAND_SEC })).toBe(0)
  })

  it('CA10 opens the TKN wallet and credits gift tokens when gifting to a brand without TKN', async () => {
    const res = await http()
      .post(`/admin/token-wallets/${BRAND_GIFT}/gifts`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ amount: 25, reason: 'Welcome gift', idempotencyKey: 'loc251-gift-1' })

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body.data.wallet).toMatchObject({
      brandId: BRAND_GIFT,
      currency: 'TKN',
      status: WalletStatus.ACTIVE,
      balance: 25,
      byOrigin: { gift: 25, purchased: 0, dropi: 0 },
    })

    const tx = await dataSource.getRepository(Transaction).findOneByOrFail({ brandId: BRAND_GIFT })
    expect([tx.type, Number(tx.amount), tx.tokenOrigin]).toEqual([
      TransactionType.CREDIT,
      25,
      'gift',
    ])
  })
})
