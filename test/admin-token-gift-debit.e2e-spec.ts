/**
 * Admin gift token debits (`POST /admin/token-wallets/:brandId/gift-debits`) over HTTP against
 * PostgreSQL.
 * R6: one responsibility, the `POST /admin/token-wallets/:brandId/gift-debits` endpoint and its
 * idempotency, row lock, and audit invariants behind one test app; splitting would duplicate its setup.
 */
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource, EntityManager } from 'typeorm'

import { AddTokenWalletOrigins1793949572497 } from '../migrations/1793949572497-AddTokenWalletOrigins'
import { AddTokenGiftNotices1794350000000 } from '../migrations/1794350000000-AddTokenGiftNotices'
import { AdminTokenGiftController } from '../src/admin/admin-token-gift.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import { TokenGiftNotice } from '../src/wallet/entities/token-gift-notice.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { TokenOrigin } from '../src/wallet/token-origin'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { failNextAuditWrite, failNextWriteOf } from './support/audit-failure.fixture'
import { unknownServiceKeys } from './support/service-credential.double'

dotenvConfig({ path: '.env' })

const [BRAND_A, BRAND_EMPTY] = [
  'a2520000-0000-4000-8000-0000000000a1',
  'a2520000-0000-4000-8000-0000000000b2',
]
const [SUPERADMIN_ID, BRAND_ADMIN_ID] = ['superadmin-loc252', 'brand-admin-loc252']
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc252-jwt-secret', 'e2e-loc252-server-token']

describe('Admin gift token debits over HTTP (PostgreSQL, LOC-252)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let tokens: TokenWalletService
  let superAdmin = ''
  let brandAdmin = ''

  const http = () => request(app.getHttpServer())
  const gift = (body: Record<string, unknown>, token = superAdmin, brandId = BRAND_A) =>
    http()
      .post(`/admin/token-wallets/${brandId}/gifts`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const debitGift = (body: Record<string, unknown>, token = superAdmin, brandId = BRAND_A) =>
    http()
      .post(`/admin/token-wallets/${brandId}/gift-debits`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const tokenWallet = (brandId = BRAND_A) =>
    dataSource.getRepository(Wallet).findOneBy({ brandId, currency: 'TKN' })
  const movementsOf = (walletId: string) =>
    dataSource.getRepository(Transaction).find({ where: { walletId }, order: { createdAt: 'ASC' } })
  const auditsOf = (walletId: string) =>
    dataSource.getRepository(AuditLog).findBy({ entityType: 'wallet', entityId: walletId })

  const seedTokenWallet = async (
    counts: { gift?: number; purchased?: number; dropi?: number } = {},
    status: WalletStatus = WalletStatus.ACTIVE,
  ) => {
    const view = await tokens.getOrCreate(BRAND_A, BRAND_A)
    if (counts.gift) {
      await tokens.creditTokens(view.id, counts.gift, TokenOrigin.GIFT, { brandId: BRAND_A })
    }
    if (counts.purchased) {
      await tokens.creditTokens(view.id, counts.purchased, TokenOrigin.PURCHASED, {
        brandId: BRAND_A,
      })
    }
    if (counts.dropi) {
      await tokens.creditTokens(view.id, counts.dropi, TokenOrigin.DROPI, { brandId: BRAND_A })
    }
    if (status !== WalletStatus.ACTIVE) {
      await dataSource.getRepository(Wallet).update({ id: view.id }, { status })
    }
    return view.id
  }

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    const brands = [BRAND_A, BRAND_EMPTY]
    await dataSource.query('DELETE FROM token_gift_notices WHERE "brandId" = ANY($1)', [brands])
    await dataSource.query(
      'DELETE FROM audit_log WHERE "entityType" = \'wallet\' AND "entityId" IN (SELECT id::text FROM wallets WHERE "brandId" = ANY($1))',
      [brands],
    )
    await dataSource.query('DELETE FROM transactions WHERE "brandId" = ANY($1)', [brands])
    await dataSource.query('DELETE FROM wallets WHERE "brandId" = ANY($1)', [brands])
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
      entities: [Wallet, Transaction, AuditLog, TokenGiftNotice],
      synchronize: false,
    })
    await dataSource.initialize()
    const hasOrigins = await dataSource.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'wallets' AND column_name = 'giftTokens'`,
    )
    if (!hasOrigins.length) {
      const runner = dataSource.createQueryRunner()
      try {
        await new AddTokenWalletOrigins1793949572497().up(runner)
      } finally {
        await runner.release()
      }
    }
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
    superAdmin = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })
    brandAdmin = jwtService.sign({ id: BRAND_ADMIN_ID, isSuperAdmin: false, brand: BRAND_A })
    const repo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminTokenGiftController],
      providers: [
        AuditService,
        TokenWalletService,
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: JwtService, useValue: jwtService },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        ...[Wallet, Transaction, AuditLog, TokenGiftNotice].flatMap((e) => [
          repo(e, 'DBWrite'),
          repo(e, 'DBRead'),
        ]),
        // R17: these routes use @RequireSuperAdmin, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
    tokens = app.get(TokenWalletService)
  })

  beforeEach(clean)
  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await clean()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it('CA5 debits 20 gift tokens from a wallet with 30 gift and 100 purchased, leaving 10 gift, 100 purchased, balance 110, and a token_gift_debit audit row', async () => {
    // R15: red when debitGiftTokens skips deducting giftTokens or skips writing token_gift_debit audit.
    const walletId = await seedTokenWallet({ gift: 30, purchased: 100 })

    const res = await debitGift({
      amount: 20,
      reason: ' mistaken bonus ',
      idempotencyKey: 'loc252-d1',
    })

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body.data.wallet).toMatchObject({
      id: walletId,
      brandId: BRAND_A,
      balance: 110,
      byOrigin: { gift: 10, purchased: 100, dropi: 0 },
      unassigned: 0,
    })
    const stored = (await tokenWallet())!
    expect([
      Number(stored.giftTokens),
      Number(stored.purchasedTokens),
      Number(stored.dropiTokens),
      Number(stored.balance),
    ]).toEqual([10, 100, 0, 110])
    const debits = (await movementsOf(walletId)).filter((m) => m.type === TransactionType.DEBIT)
    expect(debits).toHaveLength(1)
    expect(debits[0]).toMatchObject({
      type: TransactionType.DEBIT,
      tokenOrigin: TokenOrigin.GIFT,
      amount: '20.00',
      balanceBefore: '130.00',
      balanceAfter: '110.00',
      category: 'gift_debit',
      description: 'mistaken bonus',
      referenceType: 'admin',
      referenceId: SUPERADMIN_ID,
      idempotencyKey: 'admin:loc252-d1',
      metadata: { authorId: SUPERADMIN_ID, reason: 'mistaken bonus' },
    })
  })

  it('records a token_gift_debit audit row with author, reason, amount, and transactionId in the same transaction', async () => {
    // R15: red when debitGift omits the audit callback or records action other than token_gift_debit.
    const walletId = await seedTokenWallet({ gift: 30, purchased: 100 })

    const res = await debitGift({
      amount: 20,
      reason: ' mistaken bonus ',
      idempotencyKey: 'loc252-audit-1',
    })

    expect(res.status).toBe(HttpStatus.CREATED)
    const debits = (await movementsOf(walletId)).filter((m) => m.type === TransactionType.DEBIT)
    expect(debits).toHaveLength(1)
    const audits = await auditsOf(walletId)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      userId: SUPERADMIN_ID,
      action: 'token_gift_debit',
      entityType: 'wallet',
      entityId: walletId,
      changes: {
        brandId: BRAND_A,
        amount: 20,
        reason: 'mistaken bonus',
        transactionId: debits[0].id,
      },
      description: 'Gift debit of 20 tokens: mistaken bonus',
    })
  })

  it('CA5 refuses to debit 40 when only 10 gift tokens remain even with 100 purchased, returning 400 INSUFFICIENT_GIFT_TOKENS without touching purchased', async () => {
    // R15: red when the debit consumes purchased tokens once gift runs out: purchased drops below 100 and status is 201.
    const walletId = await seedTokenWallet({ gift: 10, purchased: 100, dropi: 50 })

    const res = await debitGift({
      amount: 40,
      reason: 'Exceeds gift balance',
      idempotencyKey: 'loc252-d2',
    })

    const stored = (await tokenWallet())!
    expect(Number(stored.purchasedTokens)).toBe(100)
    expect([Number(stored.giftTokens), Number(stored.dropiTokens), Number(stored.balance)]).toEqual(
      [10, 50, 160],
    )
    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body.code).toBe('INSUFFICIENT_GIFT_TOKENS')
    const debits = (await movementsOf(walletId)).filter((m) => m.type === TransactionType.DEBIT)
    expect(debits).toHaveLength(0)
    expect(await auditsOf(walletId)).toHaveLength(0)
  })

  it('CA5 repeating the same gift debit request with the same key returns 201 with the same movement and debits 20 only once', async () => {
    // R15: red when debitGift stops forwarding the idempotency key: the second call debits another 20 and leaves gift at 0.
    const walletId = await seedTokenWallet({ gift: 30, purchased: 100 })
    const body = { amount: 20, reason: 'Duplicate click', idempotencyKey: 'loc252-d3' }

    const first = await debitGift(body)
    const second = await debitGift(body)

    expect([first.status, second.status]).toEqual([HttpStatus.CREATED, HttpStatus.CREATED])
    expect(second.body.data.transaction.id).toBe(first.body.data.transaction.id)
    expect([first.body.data.replayed, second.body.data.replayed]).toEqual([false, true])
    const stored = (await tokenWallet())!
    expect([
      Number(stored.giftTokens),
      Number(stored.purchasedTokens),
      Number(stored.balance),
    ]).toEqual([10, 100, 110])
    const debits = (await movementsOf(walletId)).filter((m) => m.type === TransactionType.DEBIT)
    expect(debits).toHaveLength(1)
    expect(await auditsOf(walletId)).toHaveLength(1)
  })

  it('CA5 reusing the idempotency key of a given gift or of a debit with another amount returns 409 IDEMPOTENCY_KEY_CONFLICT and moves nothing', async () => {
    // R15: red when findReplay matches by key alone without checking type or amount: returns 201 instead of 409.
    const giftRes = await gift({
      amount: 30,
      reason: 'Initial gift',
      idempotencyKey: 'loc252-g1',
    })
    expect(giftRes.status).toBe(HttpStatus.CREATED)
    const walletId: string = giftRes.body.data.wallet.id

    const reuseGiftKey = await debitGift({
      amount: 30,
      reason: 'Reuse credit key',
      idempotencyKey: 'loc252-g1',
    })
    expect(reuseGiftKey.status).toBe(HttpStatus.CONFLICT)
    expect(reuseGiftKey.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT')

    const firstDebit = await debitGift({
      amount: 10,
      reason: 'First debit',
      idempotencyKey: 'loc252-d4',
    })
    expect(firstDebit.status).toBe(HttpStatus.CREATED)

    const reuseDifferentAmount = await debitGift({
      amount: 5,
      reason: 'Same key other amount',
      idempotencyKey: 'loc252-d4',
    })
    expect(reuseDifferentAmount.status).toBe(HttpStatus.CONFLICT)
    expect(reuseDifferentAmount.body.code).toBe('IDEMPOTENCY_KEY_CONFLICT')

    const stored = (await tokenWallet())!
    expect([Number(stored.giftTokens), Number(stored.balance)]).toEqual([20, 20])
    const debits = (await movementsOf(walletId)).filter((m) => m.type === TransactionType.DEBIT)
    expect(debits).toHaveLength(1)
  })

  it('accepts a frozen token wallet with 201 and debits its gift tokens', async () => {
    // R15: red when debitGiftTokens requires ACTIVE like debitTokens: frozen fails with 422.
    await seedTokenWallet({ gift: 20 }, WalletStatus.FROZEN)

    const frozenRes = await debitGift({
      amount: 5,
      reason: 'Frozen debit',
      idempotencyKey: 'loc252-frozen',
    })
    expect(frozenRes.status).toBe(HttpStatus.CREATED)
    expect(Number((await tokenWallet())!.giftTokens)).toBe(15)
  })

  it('rejects a closed token wallet with 422 WALLET_CLOSED and moves nothing', async () => {
    // R15: red when debitGiftTokens skips the CLOSED check: closed returns 201 and debits 5.
    await seedTokenWallet({ gift: 20 }, WalletStatus.CLOSED)

    const closedRes = await debitGift({
      amount: 5,
      reason: 'Closed debit',
      idempotencyKey: 'loc252-closed',
    })
    expect(closedRes.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(closedRes.body.code).toBe('WALLET_CLOSED')
    expect(Number((await tokenWallet())!.giftTokens)).toBe(20)
  })

  it('returns 404 WALLET_NOT_FOUND when the brand has no TKN wallet and never creates one', async () => {
    // R15: red when debitGift calls getOrCreate instead of findTokenWalletId: creates a wallet and returns 400.
    const res = await debitGift(
      { amount: 5, reason: 'Brand has no wallet', idempotencyKey: 'loc252-no-wallet' },
      superAdmin,
      BRAND_EMPTY,
    )

    expect(res.status).toBe(HttpStatus.NOT_FOUND)
    expect(res.body.code).toBe('WALLET_NOT_FOUND')
    expect(await tokenWallet(BRAND_EMPTY)).toBeNull()
  })

  it('rolls back the balance and movement when the transaction or audit write fails, and a retry with the same key applies once', async () => {
    // R15: red when audit is recorded outside the transaction: the failed attempt keeps the debit and the retry skips the audit.
    const walletId = await seedTokenWallet({ gift: 30 })

    failNextWriteOf(Transaction)
    const txFailed = await debitGift({
      amount: 10,
      reason: 'Tx write failure',
      idempotencyKey: 'loc252-fail-tx',
    })
    expect(txFailed.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect(Number((await tokenWallet())!.giftTokens)).toBe(30)

    jest.restoreAllMocks()
    failNextAuditWrite()
    const auditFailed = await debitGift({
      amount: 10,
      reason: 'Audit write failure',
      idempotencyKey: 'loc252-fail-audit',
    })
    expect(auditFailed.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect(Number((await tokenWallet())!.giftTokens)).toBe(30)
    expect(await auditsOf(walletId)).toHaveLength(0)

    jest.restoreAllMocks()
    const retried = await debitGift({
      amount: 10,
      reason: 'Audit write failure',
      idempotencyKey: 'loc252-fail-audit',
    })
    expect(retried.status).toBe(HttpStatus.CREATED)
    expect(Number((await tokenWallet())!.giftTokens)).toBe(20)
    expect(await auditsOf(walletId)).toHaveLength(1)
  })

  it('rejects the server token with 403 and moves nothing', async () => {
    // R15: red when @RequireSessionUser is missing: the server token passes as superadmin and gets 201.
    const walletId = await seedTokenWallet({ gift: 20 })

    const serverRes = await debitGift(
      { amount: 5, reason: 'Server token', idempotencyKey: 'loc252-sec-server' },
      ACCESS_SERVER,
    )

    expect(serverRes.status).toBe(HttpStatus.FORBIDDEN)
    expect(Number((await tokenWallet())!.giftTokens)).toBe(20)
    expect(await auditsOf(walletId)).toHaveLength(0)
  })

  it('rejects a non-superadmin brand admin session with 403 and moves nothing', async () => {
    // R15: red when @RequireSuperAdmin is missing: a brand admin session gets 201.
    const walletId = await seedTokenWallet({ gift: 20 })

    const memberRes = await debitGift(
      { amount: 5, reason: 'Brand admin', idempotencyKey: 'loc252-sec-member' },
      brandAdmin,
    )

    expect(memberRes.status).toBe(HttpStatus.FORBIDDEN)
    expect(Number((await tokenWallet())!.giftTokens)).toBe(20)
    expect(await auditsOf(walletId)).toHaveLength(0)
  })

  it.each([
    ['blank reason', { amount: 5, reason: '   ', idempotencyKey: 'loc252-v1' }],
    ['missing reason', { amount: 5, idempotencyKey: 'loc252-v2' }],
    ['missing key', { amount: 5, reason: 'Valid' }],
    ['amount 0', { amount: 0, reason: 'Valid', idempotencyKey: 'loc252-v3' }],
    ['amount -5', { amount: -5, reason: 'Valid', idempotencyKey: 'loc252-v4' }],
    [
      'amount 0.005 (three decimals)',
      { amount: 0.005, reason: 'Valid', idempotencyKey: 'loc252-v5' },
    ],
    ['amount 1e-7 (exponent form)', { amount: 1e-7, reason: 'Valid', idempotencyKey: 'loc252-v6' }],
    ['amount as string', { amount: '5', reason: 'Valid', idempotencyKey: 'loc252-v7' }],
    ['amount null', { amount: null, reason: 'Valid', idempotencyKey: 'loc252-v8' }],
    [
      'amount 1e20 (over column max)',
      { amount: 1e20, reason: 'Valid', idempotencyKey: 'loc252-v9' },
    ],
  ])('rejects invalid payload (%s) with 400 and never 500', async (_label, body) => {
    // R15: red when GiftTokensDto drops its reason, key, decimal, or upper-bound validators.
    await seedTokenWallet({ gift: 20 })

    const res = await debitGift(body)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(Number((await tokenWallet())!.giftTokens)).toBe(20)
  })

  it('concurrency: two simultaneous debits of 20 with distinct keys on 30 gift tokens finish with one 201, one 400 INSUFFICIENT_GIFT_TOKENS, and 10 gift left', async () => {
    // R15: red when the row lock (pessimistic_write) is removed: both read 30, both return 201, and giftTokens ends at -10.
    const walletId = await seedTokenWallet({ gift: 30, purchased: 100 })
    const findOne = EntityManager.prototype.findOne
    const save = EntityManager.prototype.save
    let releaseFind!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      releaseFind = resolve
    })
    let entered = 0
    // R17: holding both requests at moveIn's wallet read forces them to contend on the row lock at the same instant.
    jest.spyOn(EntityManager.prototype, 'findOne').mockImplementation(async function (
      this: EntityManager,
      ...args: unknown[]
    ) {
      if (args[0] === Wallet && this.queryRunner?.isTransactionActive && entered < 2) {
        if (++entered === 2) releaseFind()
        await bothEntered
      }
      return (findOne as (...all: unknown[]) => Promise<unknown>).apply(this, args)
    } as EntityManager['findOne'])
    let releaseSave!: () => void
    const bothSaving = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    let saving = 0
    // R17: when pessimistic_write is active, the second request waits on the row lock at findOne so saving stays 1 and times out; without the lock both read 30 and reach save together.
    jest.spyOn(EntityManager.prototype, 'save').mockImplementation(async function (
      this: EntityManager,
      ...args: unknown[]
    ) {
      if (args[0] === Wallet && this.queryRunner?.isTransactionActive && saving < 2) {
        if (++saving === 2) releaseSave()
        await Promise.race([bothSaving, new Promise((resolve) => setTimeout(resolve, 150))])
      }
      return (save as (...all: unknown[]) => Promise<unknown>).apply(this, args)
    } as EntityManager['save'])

    const [first, second] = await Promise.all([
      debitGift({ amount: 20, reason: 'Concurrent A', idempotencyKey: 'loc252-race-a' }),
      debitGift({ amount: 20, reason: 'Concurrent B', idempotencyKey: 'loc252-race-b' }),
    ])

    const stored = (await tokenWallet())!
    expect(Number(stored.giftTokens)).toBe(10)
    expect([Number(stored.purchasedTokens), Number(stored.balance)]).toEqual([100, 110])
    expect([first.status, second.status].sort()).toEqual([
      HttpStatus.CREATED,
      HttpStatus.BAD_REQUEST,
    ])
    const rejected = first.status === HttpStatus.BAD_REQUEST ? first : second
    expect(rejected.body.code).toBe('INSUFFICIENT_GIFT_TOKENS')
    const debits = (await movementsOf(walletId)).filter((m) => m.type === TransactionType.DEBIT)
    expect(debits).toHaveLength(1)
    expect(await auditsOf(walletId)).toHaveLength(1)
  })

  it('concurrency: two simultaneous debits of 20 with the same key on 30 gift tokens both return 201 and debit 20 once with one audit row', async () => {
    // R15: red when moveIn skips findReplay under the wallet lock: the second request either debits twice or fails with 500.
    const walletId = await seedTokenWallet({ gift: 30 })
    const findOne = EntityManager.prototype.findOne
    let releaseBoth!: () => void
    const bothEntered = new Promise<void>((resolve) => {
      releaseBoth = resolve
    })
    let entered = 0
    // R17: holding both requests at moveIn's wallet read forces them to reach the lock and replay check together.
    jest.spyOn(EntityManager.prototype, 'findOne').mockImplementation(async function (
      this: EntityManager,
      ...args: unknown[]
    ) {
      if (args[0] === Wallet && this.queryRunner?.isTransactionActive && entered < 2) {
        if (++entered === 2) releaseBoth()
        await bothEntered
      }
      return (findOne as (...all: unknown[]) => Promise<unknown>).apply(this, args)
    } as EntityManager['findOne'])
    const body = { amount: 20, reason: 'Same key race', idempotencyKey: 'loc252-race-same' }

    const [first, second] = await Promise.all([debitGift(body), debitGift(body)])

    expect([first.status, second.status]).toEqual([HttpStatus.CREATED, HttpStatus.CREATED])
    expect(first.body.data.transaction.id).toBe(second.body.data.transaction.id)
    expect([first.body.data.replayed, second.body.data.replayed].sort()).toEqual([false, true])
    expect(Number((await tokenWallet())!.giftTokens)).toBe(10)
    const debits = (await movementsOf(walletId)).filter((m) => m.type === TransactionType.DEBIT)
    expect(debits).toHaveLength(1)
    expect(await auditsOf(walletId)).toHaveLength(1)
  })
})
