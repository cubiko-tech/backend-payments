/**
 * Admin list filters (wallets, subscriptions, payments) over HTTP against PostgreSQL: a status
 * outside its enum is only rejected by the database, so the 500 it gives without a DTO, and the
 * rows each filter keeps, need a real table.
 */
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AdminController } from '../src/admin/admin.controller'
import { AuditService } from '../src/audit/audit.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { CreditService } from '../src/credit/credit.service'
import { Payment } from '../src/payment/entities/payment.entity'
import { ProviderConfig } from '../src/provider/entities/providerConfig.entity'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import {
  createGlobalValidationPipe,
  INVALID_REQUEST,
} from '../src/shared/validation/global-validation-pipe'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { WalletService } from '../src/wallet/wallet.service'
import { unknownServiceKeys } from './support/service-credential.double'
import { authSessionsDouble } from './support/auth-session.double'
import { SessionVerifier } from '../src/shared/auth/session-verifier.service'

dotenvConfig({ path: '.env' })

const [BRAND_A, BRAND_B, BRAND_TOKENS] = [
  'a3110001-0000-4000-8000-000000000001',
  'a3110002-0000-4000-8000-000000000002',
  'a3110003-0000-4000-8000-000000000003',
]
const BRANDS = [BRAND_A, BRAND_B, BRAND_TOKENS]
const TOKENS_LABEL = 'loc311-tercera'
// A literal `%` or `_` in its label, and a look-alike only a wildcard reading of it matches.
const [BRAND_PERCENT, BRAND_PERCENT_LOOKALIKE, BRAND_UNDERSCORE, BRAND_UNDERSCORE_LOOKALIKE] = [
  'c3220001-0000-4000-8000-000000000001',
  'c3220002-0000-4000-8000-000000000002',
  'c3220003-0000-4000-8000-000000000003',
  'c3220004-0000-4000-8000-000000000004',
]
const WILDCARD_BRANDS = [
  BRAND_PERCENT,
  BRAND_PERCENT_LOOKALIKE,
  BRAND_UNDERSCORE,
  BRAND_UNDERSCORE_LOOKALIKE,
]
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc311-jwt-secret', 'e2e-loc311-server-token']

describe('Admin list filters over HTTP (PostgreSQL, LOC-311)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let superAdmin = ''

  const get = (path: string, query: Record<string, string>, token = superAdmin) =>
    request(app.getHttpServer())
      .get(`/admin/${path}`)
      .query(query)
      .set('Authorization', `Bearer ${token}`)
  const brandsOf = (body: { data: { brandId: string }[] }) =>
    body.data.map((row) => row.brandId).sort()

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    await dataSource.query(`DELETE FROM wallets WHERE "brandId" = ANY($1)`, [
      [...BRANDS, ...WILDCARD_BRANDS],
    ])
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER })
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [Payment, Subscription, Wallet],
      synchronize: false,
    })
    await dataSource.initialize()

    const sessions = authSessionsDouble()
    superAdmin = sessions.sign({ id: 'superadmin-loc311', isSuperAdmin: true, brand: null })
    const repo = (entity: typeof Payment | typeof Subscription | typeof Wallet, conn: string) => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: SessionVerifier, useValue: sessions },
        ...[Subscription, Payment, Wallet].flatMap((e) => [repo(e, 'DBRead'), repo(e, 'DBWrite')]),
        // R17: the constructor needs them; the list routes never touch these tables.
        { provide: getRepositoryToken(ProviderConfig, 'DBRead'), useValue: {} },
        { provide: getRepositoryToken(ProviderConfig, 'DBWrite'), useValue: {} },
        { provide: getRepositoryToken(WalletBalanceSnapshot, 'DBRead'), useValue: {} },
        { provide: getRepositoryToken(Transaction, 'DBWrite'), useValue: {} },
        // R17: constructor dependencies the list routes never call.
        { provide: AuditService, useValue: {} },
        { provide: CreditService, useValue: {} },
        { provide: WalletService, useValue: {} },
        // R17: these routes use @RequireSuperAdmin, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()

    await clean()
    const wallets = dataSource.getRepository(Wallet)
    const rows: [string, string, string][] = [
      [BRAND_A, 'COP', 'loc311-a'],
      [BRAND_B, 'COP', 'loc311-b'],
      [BRAND_TOKENS, 'TKN', TOKENS_LABEL],
      [BRAND_PERCENT, 'COP', 'loc322 50% off'],
      [BRAND_PERCENT_LOOKALIKE, 'COP', 'loc322 50 off'],
      [BRAND_UNDERSCORE, 'COP', 'loc322 x_y'],
      [BRAND_UNDERSCORE_LOOKALIKE, 'COP', 'loc322 xzy'],
    ]
    for (const [brandId, currency, label] of rows)
      await wallets.save(
        wallets.create({
          brandId,
          userId: brandId,
          provider: 'internal',
          currency,
          status: WalletStatus.ACTIVE,
          label,
        }),
      )
  })

  afterAll(async () => {
    await clean()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it('lists only the wallets of the resolved brands', async () => {
    // Mutation: drop the brandIds condition in walletsList and count grows to every wallet in the table.
    const res = await get('wallets', { brandIds: `${BRAND_A},${BRAND_B}`, perPage: '100' })

    expect(res.status).toBe(HttpStatus.OK)
    expect(res.body.count).toBe(2)
    expect(brandsOf(res.body)).toEqual([BRAND_A, BRAND_B])
  })

  it('adds the brands whose label matches the search to the resolved ones', async () => {
    // Mutation: join brandIds and search with AND, no wallet of BRAND_A has that label and this is empty.
    const res = await get('wallets', { brandIds: BRAND_A, search: TOKENS_LABEL, perPage: '100' })

    expect(res.status).toBe(HttpStatus.OK)
    expect(res.body.count).toBe(2)
    expect(brandsOf(res.body)).toEqual([BRAND_A, BRAND_TOKENS])
  })

  it.each([
    ['%', '50%', BRAND_PERCENT],
    ['_', 'x_y', BRAND_UNDERSCORE],
  ])('reads %s in the search as a literal next to two resolved brands', async (_c, search, hit) => {
    // Mutation (%): drop `%` from the class in containsPattern, `50 off` joins.
    // Mutation (_): drop `_` from the class in containsPattern, `xzy` joins.
    const res = await get('wallets', { brandIds: `${BRAND_A},${BRAND_B}`, search, perPage: '100' })

    expect(res.status).toBe(HttpStatus.OK)
    const ours = brandsOf(res.body).filter((id) => [...BRANDS, ...WILDCARD_BRANDS].includes(id))
    expect(ours).toEqual([BRAND_A, BRAND_B, hit].sort())
  })

  it.each(['wallets', 'subscriptions', 'payments'])(
    'answers 400, not 500, to a status outside its enum on %s',
    async (path) => {
      // Mutation: back to a loose @Query('status') on that handler and Postgres rejects the enum: 500.
      const res = await get(path, { status: 'no-existe' })

      expect(res.status).toBe(HttpStatus.BAD_REQUEST)
      expect(res.body.code).toBe(INVALID_REQUEST)
    },
  )

  it.each([
    ['a non-UUID', 'no-uuid'],
    ['an empty list', ''],
    ['only commas', ','],
    [
      '101 ids',
      Array.from(
        { length: 101 },
        (_, i) => `a3110000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ).join(','),
    ],
  ])('answers 400 to brandIds with %s', async (_label, brandIds) => {
    // Mutation: drop @IsUUID (non-UUID) or @ArrayMaxSize(100) (101 ids) and that list is 200;
    // drop @ArrayMinSize(1) and the empty lists reach Postgres as `IN ()` and answer 500.
    const res = await get('wallets', { brandIds })

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body.code).toBe(INVALID_REQUEST)
  })

  it('filters by currency in any case', async () => {
    // Mutation: drop the toUpperCase of currency and `tkn` matches no stored wallet.
    const scope = { brandIds: BRANDS.join(','), perPage: '100' }
    const [lower, upper] = [
      await get('wallets', { ...scope, currency: 'tkn' }),
      await get('wallets', { ...scope, currency: 'TKN' }),
    ]

    expect([lower.status, upper.status]).toEqual([HttpStatus.OK, HttpStatus.OK])
    expect(brandsOf(lower.body)).toEqual([BRAND_TOKENS])
    expect(lower.body.count).toBe(upper.body.count)
    expect(brandsOf(lower.body)).toEqual(brandsOf(upper.body))
  })

  const expectInvalid = async (query: Record<string, string>) => {
    const res = await get('wallets', query)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body.code).toBe(INVALID_REQUEST)
  }

  it('answers 400 to perPage in exponent form', async () => {
    // Mutation: parseInt instead of Number in toInteger reads 1e-7 as 1 and this is 200.
    await expectInvalid({ perPage: '1e-7' })
  })

  it.each(['abc', 'null'])('answers 400 to perPage=%s', async (perPage) => {
    // Mutation: toInteger reads a non-number as absent (`Number(value) || undefined`) and this is 200.
    await expectInvalid({ perPage })
  })

  it('answers 400 to a fractional perPage', async () => {
    // Mutation: drop @IsInt from perPage and 1.5 is 200.
    await expectInvalid({ perPage: '1.5' })
  })

  it('answers 400 to perPage=0', async () => {
    // Mutation: drop @Min(1) from perPage and 0 is 200.
    await expectInvalid({ perPage: '0' })
  })

  it('answers 400 to perPage above 100', async () => {
    // Mutation: drop @Max(MAX_LIST_PER_PAGE) from perPage and 101 is 200.
    await expectInvalid({ perPage: '101' })
  })

  it('answers 400 to a page above its cap', async () => {
    // Mutation: drop @Max(MAX_LIST_PAGE) from page and 100001 is 200.
    await expectInvalid({ page: '100001' })
  })

  it.each(['TK', 'TKNN'])('answers 400 to currency=%s', async (currency) => {
    // Mutation: drop @Length(3, 3) from currency and the code is 200.
    await expectInvalid({ currency })
  })

  it('keeps answering the processes whitelist with the server token', async () => {
    // Mutation: drop planSlug from SubscriptionsListQueryDto and forbidNonWhitelisted answers 400.
    const res = await get(
      'subscriptions',
      {
        page: '1',
        status: 'active',
        planSlug: 'loc311-plan',
        orderBy: 'createdAt',
        order: 'DESC',
        perPage: '100',
      },
      ACCESS_SERVER,
    )

    expect(res.status).toBe(HttpStatus.OK)
    expect(Array.isArray(res.body.data)).toBe(true)
  })

  it.each([
    ['wallets', { status: 'active', provider: 'internal' }],
    ['subscriptions', { status: 'trial', provider: 'dropi' }],
    ['payments', { status: 'completed', provider: 'wallet', purpose: 'wallet_recharge' }],
  ])('keeps answering the parameters the admin finance page sends to %s', async (path, filters) => {
    // Mutation: strip the decorators of `provider` in WalletsListQueryDto (wallets), of `status` in
    // SubscriptionsListQueryDto (subscriptions) or of `purpose` in PaymentsListQueryDto (payments): 400.
    const base = { page: '1', perPage: '20', orderBy: 'createdAt', order: 'DESC', search: 'loc311' }
    const res = await get(path, { ...base, ...filters })

    expect(res.status).toBe(HttpStatus.OK)
    expect(Array.isArray(res.body.data)).toBe(true)
  })

  it('reads a blank status as no filter', async () => {
    // Mutation: stop reading a blank value as absent and status= fails the enum with 400.
    const res = await get('wallets', { brandIds: `${BRAND_A},${BRAND_B}`, status: '' })

    expect(res.status).toBe(HttpStatus.OK)
    expect(res.body.count).toBe(2)
  })
})
