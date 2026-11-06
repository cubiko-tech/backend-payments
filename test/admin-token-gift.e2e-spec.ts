import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource, EntityManager } from 'typeorm'

import { AddTokenWalletOrigins1793949572497 } from '../migrations/1793949572497-AddTokenWalletOrigins'
import { AdminTokenGiftController } from '../src/admin/admin-token-gift.controller'
import { AdminController } from '../src/admin/admin.controller'
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
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { WalletController } from '../src/wallet/wallet.controller'
import { WalletService } from '../src/wallet/wallet.service'

dotenvConfig({ path: '.env' })

const BRAND_A = 'a1330000-0000-4000-8000-0000000000e2'
const SUPERADMIN_ID = 'superadmin-loc133'
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc133-jwt-secret', 'e2e-loc133-server-token']

describe('Gift tokens and keyed admin adjustments over HTTP (PostgreSQL, LOC-133)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let superAdmin = ''

  const http = () => request(app.getHttpServer())
  const gift = (body: Record<string, unknown>, token = superAdmin) =>
    http()
      .post(`/admin/token-wallets/${BRAND_A}/gifts`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const adjust = (walletId: string, body: Record<string, unknown>, token = superAdmin) =>
    http()
      .post(`/admin/wallets/${walletId}/adjust`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const tokenWallet = () =>
    dataSource.getRepository(Wallet).findOneBy({ brandId: BRAND_A, currency: 'TKN' })
  const balanceOf = async (id: string) =>
    Number((await dataSource.getRepository(Wallet).findOneByOrFail({ id })).balance)
  const movementsOf = (walletId: string) =>
    dataSource.getRepository(Transaction).findBy({ walletId })
  const auditsOf = (walletId: string) =>
    dataSource.getRepository(AuditLog).findBy({ entityType: 'wallet', entityId: walletId })
  const seedWallet = (currency: string, balance: number, provider = 'internal') =>
    dataSource.getRepository(Wallet).save(
      dataSource.getRepository(Wallet).create({
        brandId: BRAND_A,
        userId: BRAND_A,
        provider: provider as any,
        currency,
        balance,
        status: WalletStatus.ACTIVE,
      }),
    )

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    for (const sql of [
      'DELETE FROM audit_log WHERE "entityType" = \'wallet\' AND "entityId" IN (SELECT id::text FROM wallets WHERE "brandId" = $1)',
      'DELETE FROM transactions WHERE "brandId" = $1',
      'DELETE FROM wallets WHERE "brandId" = $1',
    ])
      await dataSource.query(sql, [BRAND_A])
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

    const jwtService = new JwtService({ secret: JWT_SECRET })
    superAdmin = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })
    const repo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminController, AdminTokenGiftController, WalletController],
      providers: [
        AuditService,
        WalletService,
        TokenWalletService,
        Reflector,
        ApiAuthGuard,
        { provide: JwtService, useValue: jwtService },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        ...[Subscription, Payment, Wallet, ProviderConfig, Transaction, AuditLog].flatMap((e) => [
          repo(e, 'DBWrite'),
          repo(e, 'DBRead'),
        ]),
        repo(WalletBalanceSnapshot, 'DBRead'),
        // R17: AdminController needs it in its constructor; no wallet route calls it.
        { provide: CreditService, useValue: {} },
        // R17: a super admin never asks platform for membership; this only satisfies WalletController.
        { provide: ClientPlatformService, useValue: { canViewBrandCredit: jest.fn() } },
        // R17: these routes use @RequireSuperAdmin, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  beforeEach(clean)
  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await clean()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it('CA2 a gift sent twice with k1 adds 20 gift tokens once, with its author and no invoice', async () => {
    // R15: red when the gift loses its key (no idempotencyKey to creditTokens): the balance is 40.
    const body = { amount: 20, reason: 'Launch bonus', idempotencyKey: 'loc133-k1' }

    const first = await gift(body)
    const second = await gift(body)

    expect([first.status, second.status]).toEqual([HttpStatus.CREATED, HttpStatus.CREATED])
    const wallet = (await tokenWallet())!
    expect(Number(wallet.balance)).toBe(20)
    expect(Number(wallet.giftTokens)).toBe(20)
    const [movement, ...rest] = await movementsOf(wallet.id)
    expect(rest).toHaveLength(0)
    expect(movement).toMatchObject({
      tokenOrigin: 'gift',
      referenceType: 'admin',
      referenceId: SUPERADMIN_ID,
    })
    expect(movement.metadata).toEqual({ authorId: SUPERADMIN_ID, reason: 'Launch bonus' })
    expect((await auditsOf(wallet.id)).map((a) => [a.action, a.userId])).toEqual([
      ['token_gift', SUPERADMIN_ID],
    ])
    const invoices = await dataSource.query('SELECT id FROM invoices WHERE "brandId" = $1', [
      BRAND_A,
    ])
    expect(invoices).toHaveLength(0)
  })

  it.each([
    ['without reason', { amount: 20, idempotencyKey: 'loc133-r1' }],
    ['with a blank reason', { amount: 20, reason: '   ', idempotencyKey: 'loc133-r2' }],
    ['with NaN (null in JSON)', { amount: null, reason: 'Bonus', idempotencyKey: 'loc133-r3' }],
    ['with 0', { amount: 0, reason: 'Bonus', idempotencyKey: 'loc133-r4' }],
    ['with -5', { amount: -5, reason: 'Bonus', idempotencyKey: 'loc133-r5' }],
    ['without key', { amount: 20, reason: 'Bonus' }],
  ])('CA2 a gift %s answers 400 and moves nothing', async (_label, body) => {
    // R15: red when the DTO drops that rule (reason, positive amount or key): it answers 201.
    const res = await gift(body)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(await tokenWallet()).toBeNull()
  })

  it('CA2 the server token gets 403 on the gift and on the adjustment, and nothing moves', async () => {
    // R15: red when the server token passes as a super admin session again: the gift answers 201.
    const cop = await seedWallet('COP', 100)

    const giftRes = await gift(
      { amount: 20, reason: 'Bonus', idempotencyKey: 'loc133-s1' },
      ACCESS_SERVER,
    )
    const adjustRes = await adjust(
      cop.id,
      { type: 'credit', amount: 50, idempotencyKey: 'loc133-s2' },
      ACCESS_SERVER,
    )

    expect([giftRes.status, adjustRes.status]).toEqual([HttpStatus.FORBIDDEN, HttpStatus.FORBIDDEN])
    expect(await tokenWallet()).toBeNull()
    expect(await balanceOf(cop.id)).toBe(100)
    expect(await movementsOf(cop.id)).toHaveLength(0)
  })

  it('CA2 an adjustment sent twice with k2 adds once and audits once; without key it answers 400', async () => {
    // R15: red when the adjustment stops passing its key to credit: the balance ends at 200.
    const cop = await seedWallet('COP', 100)
    const body = { type: 'credit', amount: 50, idempotencyKey: 'loc133-k2' }

    const first = await adjust(cop.id, body)
    const second = await adjust(cop.id, body)
    const keyless = await adjust(cop.id, { type: 'credit', amount: 50 })

    expect([first.status, second.status]).toEqual([HttpStatus.CREATED, HttpStatus.CREATED])
    expect(keyless.status).toBe(HttpStatus.BAD_REQUEST)
    expect(await balanceOf(cop.id)).toBe(150)
    expect(await movementsOf(cop.id)).toHaveLength(1)
    expect((await auditsOf(cop.id)).map((a) => a.action)).toEqual(['wallet_credit'])
  })

  it('E3 a gift key reused with another amount answers 409 and keeps the first gift', async () => {
    // R15: red when findReplay stops comparing the amount: the second gift answers 201.
    await gift({ amount: 20, reason: 'Bonus', idempotencyKey: 'loc133-k3' })

    const res = await gift({ amount: 30, reason: 'Bonus', idempotencyKey: 'loc133-k3' })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(Number((await tokenWallet())!.balance)).toBe(20)
  })

  it('E6 an adjustment key reused with another amount answers 409 and moves nothing more', async () => {
    // R15: red when the previous movement under the key is returned without comparing it: 201.
    const cop = await seedWallet('COP', 100)
    await adjust(cop.id, { type: 'credit', amount: 50, idempotencyKey: 'loc133-k6' })

    const res = await adjust(cop.id, { type: 'credit', amount: 70, idempotencyKey: 'loc133-k6' })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(await balanceOf(cop.id)).toBe(150)
  })

  it('E6b two adjustments with k2 and different amounts at once: one applies, the other 409', async () => {
    // R15: red when the movement credit returns is not compared with the request: both get 201.
    const cop = await seedWallet('COP', 100)
    const credit = WalletService.prototype.credit
    let release: () => void = () => undefined
    const bothPastTheLookup = new Promise<void>((resolve) => (release = resolve))
    let arrived = 0
    // R17: only holding both past the key lookup makes them reach credit, and its lock, together.
    jest.spyOn(WalletService.prototype, 'credit').mockImplementation(async function (
      this: WalletService,
      ...args: Parameters<WalletService['credit']>
    ) {
      if (++arrived === 2) release()
      await bothPastTheLookup
      return credit.apply(this, args)
    } as WalletService['credit'])

    const results = await Promise.all([
      adjust(cop.id, { type: 'credit', amount: 50, idempotencyKey: 'loc133-k6b' }),
      adjust(cop.id, { type: 'credit', amount: 70, idempotencyKey: 'loc133-k6b' }),
    ])

    expect(results.map((r) => r.status).sort()).toEqual([HttpStatus.CREATED, HttpStatus.CONFLICT])
    expect(await movementsOf(cop.id)).toHaveLength(1)
    expect([150, 170]).toContain(await balanceOf(cop.id))
    expect(await auditsOf(cop.id)).toHaveLength(1)
  })

  it('E2 two gifts with k1 at once add 20 once and both answer 201', async () => {
    // R15: red when the gift stops passing its key to creditTokens: the balance ends at 40.
    const body = { amount: 20, reason: 'Bonus', idempotencyKey: 'loc133-k2e' }

    const results = await Promise.all([gift(body), gift(body)])

    expect(results.map((r) => r.status)).toEqual([HttpStatus.CREATED, HttpStatus.CREATED])
    const wallet = (await tokenWallet())!
    expect(Number(wallet.balance)).toBe(20)
    expect(await movementsOf(wallet.id)).toHaveLength(1)
  })

  it('E4 a gift that fails inside its transaction leaves nothing, and its retry applies once', async () => {
    // R15: red when the balance commits before the movement is written: the retry ends at 40.
    const save = EntityManager.prototype.save
    // R17: a healthy PostgreSQL does not fail the movement write, after the balance one, on demand.
    jest.spyOn(EntityManager.prototype, 'save').mockImplementation(async function (
      this: EntityManager,
      ...args: unknown[]
    ) {
      if (args[0] === Transaction) throw new Error('movement write failed after the balance')
      return (save as (...all: unknown[]) => Promise<unknown>).apply(this, args)
    } as EntityManager['save'])
    const body = { amount: 20, reason: 'Bonus', idempotencyKey: 'loc133-k4' }

    const failed = await gift(body)
    jest.restoreAllMocks()
    const retried = await gift(body)

    expect(failed.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect(retried.status).toBe(HttpStatus.CREATED)
    const wallet = (await tokenWallet())!
    expect(Number(wallet.balance)).toBe(20)
    expect(await movementsOf(wallet.id)).toHaveLength(1)
  })

  it('E7 a gift to a closed token wallet answers 422 WALLET_CLOSED and moves nothing', async () => {
    // R15: red when creditTokens stops refusing closed wallets: it answers 201 and adds 20.
    const tkn = await seedWallet('TKN', 0)
    await dataSource.getRepository(Wallet).update({ id: tkn.id }, { status: WalletStatus.CLOSED })

    const res = await gift({ amount: 20, reason: 'Bonus', idempotencyKey: 'loc133-k7' })

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('WALLET_CLOSED')
    expect(await balanceOf(tkn.id)).toBe(0)
  })

  it('E8 a gift whose audit fails keeps the movement with its author; the retry replays, no audit', async () => {
    // R15: red when the gift audits a replay: the retry writes a token_gift row.
    // R17: the audit table does not fail on demand; this is the failure after the commit.
    jest.spyOn(AuditService.prototype, 'log').mockRejectedValueOnce(new Error('audit down'))
    const body = { amount: 20, reason: 'Bonus', idempotencyKey: 'loc133-k8' }

    const failed = await gift(body)
    const retried = await gift(body)

    expect([failed.status, retried.status]).toEqual([
      HttpStatus.INTERNAL_SERVER_ERROR,
      HttpStatus.CREATED,
    ])
    const wallet = (await tokenWallet())!
    expect(Number(wallet.balance)).toBe(20)
    const [movement] = await movementsOf(wallet.id)
    expect(movement).toMatchObject({ referenceId: SUPERADMIN_ID, description: 'Bonus' })
    expect(await auditsOf(wallet.id)).toHaveLength(0)
  })

  it('CA5 an adjustment on a TKN wallet answers 422 and moves nothing', async () => {
    // R15: red when adjustWallet stops refusing TKN: the adjustment answers 201.
    const tkn = await seedWallet('TKN', 10)

    const res = await adjust(tkn.id, { type: 'credit', amount: 5, idempotencyKey: 'loc133-c5' })

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(await balanceOf(tkn.id)).toBe(10)
  })

  it('CA5 a transfer between TKN wallets answers 422 (regression of LOC-132)', async () => {
    // R15: red when transfer stops refusing TKN (wallet.service.ts, LOC-132): it answers 201.
    const tkn = await seedWallet('TKN', 10)
    const otherTkn = await seedWallet('TKN', 0, 'dropi')

    const res = await http()
      .post('/wallet/transfer')
      .set('Authorization', `Bearer ${superAdmin}`)
      .send({ fromWalletId: tkn.id, toWalletId: otherTkn.id, amount: 5 })

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(await balanceOf(tkn.id)).toBe(10)
  })

  it('CA5 an admin TKN wallet with balance 10 answers 422 and is not created', async () => {
    // R15: red when createWallet stops refusing TKN: it answers 201 with a second token wallet.
    const res = await http()
      .post('/admin/wallets')
      .set('Authorization', `Bearer ${superAdmin}`)
      .send({ brandId: BRAND_A, provider: 'stripe', currency: 'TKN', balance: 10 })

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(await dataSource.getRepository(Wallet).countBy({ brandId: BRAND_A })).toBe(0)
  })
})
