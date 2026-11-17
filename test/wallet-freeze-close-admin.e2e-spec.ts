import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletController } from '../src/wallet/wallet.controller'
import { WalletService } from '../src/wallet/wallet.service'
import { unknownServiceKeys } from './support/service-credential.double'
import { startUpstream, Upstream } from './support/token-debit.fixture'

dotenvConfig({ path: '.env' })

const BRAND_A = 'a2620000-0000-4000-8000-0000000000a1'
const [MEMBER_A_ID, SUPERADMIN_ID] = ['member-brand-a-loc262', 'superadmin-loc262']
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc262-jwt-secret', 'e2e-loc262-server-token']

describe('Wallet freeze, unfreeze, and close require a session super admin (PostgreSQL, LOC-262)', () => {
  const envSnapshot = { ...process.env }
  let platform: Upstream
  let platformHits = 0
  let app: INestApplication
  let dataSource: DataSource
  let memberA = ''
  let superAdmin = ''

  const http = () => request(app.getHttpServer())

  const platformDirectory = (): Upstream['reply'] => (path, res) => {
    platformHits += 1
    const rows = path.includes(encodeURIComponent(BRAND_A))
      ? [{ user: MEMBER_A_ID, rol: 'admin' }]
      : []
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: rows }))
  }

  const seedWallet = (
    currency: string,
    balance: number,
    status: WalletStatus = WalletStatus.ACTIVE,
    provider = 'internal',
  ) =>
    dataSource.getRepository(Wallet).save(
      dataSource.getRepository(Wallet).create({
        brandId: BRAND_A,
        userId: BRAND_A,
        provider: provider as any,
        currency,
        balance,
        status,
      }),
    )

  const readWallet = (id: string) => dataSource.getRepository(Wallet).findOneByOrFail({ id })

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    await dataSource.query('DELETE FROM transactions WHERE "brandId" = $1', [BRAND_A])
    await dataSource.query('DELETE FROM wallets WHERE "brandId" = $1', [BRAND_A])
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
      entities: [Wallet, Transaction],
      synchronize: false,
    })
    await dataSource.initialize()

    const jwtService = new JwtService({ secret: JWT_SECRET })
    memberA = jwtService.sign({ id: MEMBER_A_ID, isSuperAdmin: false, brand: BRAND_A })
    superAdmin = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })

    const repo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [WalletController],
      providers: [
        WalletService,
        ClientPlatformService,
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: JwtService, useValue: jwtService },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        ...[Wallet, Transaction].flatMap((e) => [repo(e, 'DBWrite'), repo(e, 'DBRead')]),
        // R17: WalletController routes use @RequireSuperAdmin or brand membership, never roles.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
    await app.listen(0)
  })

  beforeEach(async () => {
    platformHits = 0
    platform.mode = 'ok'
    platform.reply = platformDirectory()
    await clean()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await clean()
    await app?.close()
    await platform?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it('rejects a brand admin member on POST /wallet/:id/freeze, unfreeze and close with 403 without reading the wallet or changing its status', async () => {
    // R15: red when @RequireSuperAdmin() is removed from freeze, unfreeze or close: the member reaches the handler.
    const wallet = await seedWallet('COP', 0, WalletStatus.ACTIVE)
    const findByIdSpy = jest.spyOn(WalletService.prototype, 'findById')

    const freezeRes = await http()
      .post(`/wallet/${wallet.id}/freeze`)
      .set('Authorization', `Bearer ${memberA}`)
    const unfreezeRes = await http()
      .post(`/wallet/${wallet.id}/unfreeze`)
      .set('Authorization', `Bearer ${memberA}`)
    const closeRes = await http()
      .post(`/wallet/${wallet.id}/close`)
      .set('Authorization', `Bearer ${memberA}`)

    expect([freezeRes.status, unfreezeRes.status, closeRes.status]).toEqual([
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
    ])
    expect(platformHits).toBe(0)
    expect(findByIdSpy).not.toHaveBeenCalled()
    const row = await readWallet(wallet.id)
    expect([row.status, Number(row.balance)]).toEqual([WalletStatus.ACTIVE, 0])
  })

  it('rejects the server token ACCESS_SERVER on POST /wallet/:id/freeze, unfreeze and close with 403 without changing the wallet status', async () => {
    // R15: red when @RequireSessionUser() is removed from freeze, unfreeze or close: ACCESS_SERVER answers 201 and mutates the status.
    const activeWallet = await seedWallet('COP', 0, WalletStatus.ACTIVE)
    const frozenWallet = await seedWallet('USD', 0, WalletStatus.FROZEN)

    const freezeRes = await http()
      .post(`/wallet/${activeWallet.id}/freeze`)
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
    const unfreezeRes = await http()
      .post(`/wallet/${frozenWallet.id}/unfreeze`)
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
    const closeRes = await http()
      .post(`/wallet/${activeWallet.id}/close`)
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)

    const activeAfter = await readWallet(activeWallet.id)
    const frozenAfter = await readWallet(frozenWallet.id)
    expect([
      freezeRes.status,
      activeAfter.status,
      unfreezeRes.status,
      frozenAfter.status,
      closeRes.status,
    ]).toEqual([
      HttpStatus.FORBIDDEN,
      WalletStatus.ACTIVE,
      HttpStatus.FORBIDDEN,
      WalletStatus.FROZEN,
      HttpStatus.FORBIDDEN,
    ])
  })

  it('allows a session super admin to freeze, unfreeze and close a zero-balance money wallet in order', async () => {
    // R15: red when freeze, unfreeze or close stops transitioning the wallet row in order.
    const wallet = await seedWallet('COP', 0, WalletStatus.ACTIVE)

    const freezeRes = await http()
      .post(`/wallet/${wallet.id}/freeze`)
      .set('Authorization', `Bearer ${superAdmin}`)
    expect(freezeRes.status).toBe(HttpStatus.CREATED)
    expect((await readWallet(wallet.id)).status).toBe(WalletStatus.FROZEN)

    const unfreezeRes = await http()
      .post(`/wallet/${wallet.id}/unfreeze`)
      .set('Authorization', `Bearer ${superAdmin}`)
    expect(unfreezeRes.status).toBe(HttpStatus.CREATED)
    expect((await readWallet(wallet.id)).status).toBe(WalletStatus.ACTIVE)

    const closeRes = await http()
      .post(`/wallet/${wallet.id}/close`)
      .set('Authorization', `Bearer ${superAdmin}`)
    expect(closeRes.status).toBe(HttpStatus.CREATED)
    expect((await readWallet(wallet.id)).status).toBe(WalletStatus.CLOSED)
  })

  it('rejects a brand admin member trying to unfreeze a TKN wallet frozen by a super admin with 403 and keeps it frozen', async () => {
    // R15: red when @RequireSuperAdmin() is removed from unfreeze: the member gets 201 and the TKN wallet becomes active.
    const tkn = await seedWallet('TKN', 50, WalletStatus.ACTIVE)

    const frozenByAdmin = await http()
      .post(`/wallet/${tkn.id}/freeze`)
      .set('Authorization', `Bearer ${superAdmin}`)
    expect(frozenByAdmin.status).toBe(HttpStatus.CREATED)
    expect((await readWallet(tkn.id)).status).toBe(WalletStatus.FROZEN)

    const memberAttempt = await http()
      .post(`/wallet/${tkn.id}/unfreeze`)
      .set('Authorization', `Bearer ${memberA}`)

    const row = await readWallet(tkn.id)
    expect([memberAttempt.status, row.status, Number(row.balance)]).toEqual([
      HttpStatus.FORBIDDEN,
      WalletStatus.FROZEN,
      50,
    ])
    expect(platformHits).toBe(0)
  })

  it('rejects a session super admin closing a TKN wallet with 422 TOKEN_WALLET_RESERVED and keeps it active', async () => {
    // R15: red when close stops refusing TKN: it answers 201 and closes the token wallet.
    const tkn = await seedWallet('TKN', 0, WalletStatus.ACTIVE)

    const res = await http()
      .post(`/wallet/${tkn.id}/close`)
      .set('Authorization', `Bearer ${superAdmin}`)

    expect(res.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(res.body.code).toBe('TOKEN_WALLET_RESERVED')
    expect((await readWallet(tkn.id)).status).toBe(WalletStatus.ACTIVE)
  })

  it('rejects unauthenticated requests on POST /wallet/:id/freeze, unfreeze and close with 401', async () => {
    // R15: red when ApiAuthGuard stops guarding freeze, unfreeze or close: unauthenticated calls reach the handlers.
    const wallet = await seedWallet('COP', 0, WalletStatus.ACTIVE)

    const freezeRes = await http().post(`/wallet/${wallet.id}/freeze`)
    const unfreezeRes = await http().post(`/wallet/${wallet.id}/unfreeze`)
    const closeRes = await http().post(`/wallet/${wallet.id}/close`)

    expect([freezeRes.status, unfreezeRes.status, closeRes.status]).toEqual([
      HttpStatus.UNAUTHORIZED,
      HttpStatus.UNAUTHORIZED,
      HttpStatus.UNAUTHORIZED,
    ])
    expect((await readWallet(wallet.id)).status).toBe(WalletStatus.ACTIVE)
  })

  it('keeps POST /wallet/transfer working for a brand admin member between two wallets of their brand and currency', async () => {
    // R15: red when POST /wallet/transfer also requires super admin: the brand admin member gets 403 and balances do not move.
    const fromWallet = await seedWallet('COP', 50000, WalletStatus.ACTIVE, 'internal')
    const toWallet = await seedWallet('COP', 10000, WalletStatus.ACTIVE, 'stripe')

    const res = await http()
      .post('/wallet/transfer')
      .set('Authorization', `Bearer ${memberA}`)
      .send({ fromWalletId: fromWallet.id, toWalletId: toWallet.id, amount: 15000 })

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(platformHits).toBe(1)
    expect(Number((await readWallet(fromWallet.id)).balance)).toBe(35000)
    expect(Number((await readWallet(toWallet.id)).balance)).toBe(25000)
  })

  it('keeps intermediate states untouched when member and server-token retries race against an active or frozen wallet', async () => {
    // R15: red when any of the three handlers lets a member or server token through on concurrent retries.
    const activeCop = await seedWallet('COP', 0, WalletStatus.ACTIVE)
    const frozenTkn = await seedWallet('TKN', 25, WalletStatus.FROZEN)

    const responses = await Promise.all([
      http().post(`/wallet/${activeCop.id}/freeze`).set('Authorization', `Bearer ${memberA}`),
      http().post(`/wallet/${activeCop.id}/freeze`).set('Authorization', `Bearer ${ACCESS_SERVER}`),
      http().post(`/wallet/${activeCop.id}/close`).set('Authorization', `Bearer ${memberA}`),
      http().post(`/wallet/${activeCop.id}/close`).set('Authorization', `Bearer ${ACCESS_SERVER}`),
      http().post(`/wallet/${frozenTkn.id}/unfreeze`).set('Authorization', `Bearer ${memberA}`),
      http()
        .post(`/wallet/${frozenTkn.id}/unfreeze`)
        .set('Authorization', `Bearer ${ACCESS_SERVER}`),
    ])

    expect(responses.map((r) => r.status)).toEqual([
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
      HttpStatus.FORBIDDEN,
    ])
    expect(platformHits).toBe(0)
    const copRow = await readWallet(activeCop.id)
    const tknRow = await readWallet(frozenTkn.id)
    expect([copRow.status, Number(copRow.balance)]).toEqual([WalletStatus.ACTIVE, 0])
    expect([tknRow.status, Number(tknRow.balance)]).toEqual([WalletStatus.FROZEN, 25])
  })
})
