/**
 * An auto-login token (signed with a client secret, validated by backend-auth) never makes its bearer a super
 * admin in payments; only a session verified with JWT_SECRET does. HTTP against PostgreSQL, LOC-143.
 */
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as cookieParser from 'cookie-parser'
import { config as dotenvConfig } from 'dotenv'
import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AddTokenGiftNotices1794350000000 } from '../migrations/1794350000000-AddTokenGiftNotices'
import { AdminTokenGiftController } from '../src/admin/admin-token-gift.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { unknownServiceKeys } from './support/service-credential.double'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { TokenGiftNotice } from '../src/wallet/entities/token-gift-notice.entity'
import { Wallet } from '../src/wallet/entities/wallet.entity'
import { TokenWalletController } from '../src/wallet/token-wallet.controller'
import { TokenWalletService } from '../src/wallet/token-wallet.service'

dotenvConfig({ path: '.env' })

const BRAND_A = 'a1430000-0000-4000-8000-0000000000e2'
const [USER_ID, SUPERADMIN_ID] = ['user-loc143', 'superadmin-loc143']
const [JWT_SECRET, CLIENT_SECRET, COOKIE_SESSION] = [
  'e2e-loc143-jwt-secret',
  'e2e-loc143-client-secret',
  'e2e_loc143_session',
]

/**
 * Stands in for backend-auth `POST /client/validate-token`: a token signed with the client secret gets its own
 * payload back as `data`, every claim included; any other token gets 401.
 */
function startAuth(calls: unknown[]): Promise<Server> {
  const clientJwt = new JwtService({ secret: CLIENT_SECRET })
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      calls.push(JSON.parse(raw || '{}'))
      const token = (req.headers.authorization || '').replace(/^Bearer /, '')
      try {
        const data = clientJwt.verify(token)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ code: 'tokenValidate', data }))
      } catch {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'tokenInvalid' }))
      }
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

describe('Auto-login tokens never grant super admin (PostgreSQL, LOC-143)', () => {
  const envSnapshot = { ...process.env }
  const authCalls: unknown[] = []
  const clientJwt = new JwtService({ secret: CLIENT_SECRET })
  let auth: Server
  let app: INestApplication
  let dataSource: DataSource

  const http = () => request(app.getHttpServer())
  const autoLogin = (claims: Record<string, unknown>) =>
    clientJwt.sign({ client: 'dropi', user: USER_ID, brand: BRAND_A, ...claims })
  const giftBody = (key: string) => ({ amount: 20, reason: 'Bonus', idempotencyKey: key })
  const tokenWallet = () =>
    dataSource.getRepository(Wallet).findOneBy({ brandId: BRAND_A, currency: 'TKN' })
  const clean = async () => {
    if (!dataSource?.isInitialized) return
    for (const sql of [
      'DELETE FROM token_gift_notices WHERE "brandId" = $1',
      'DELETE FROM audit_log WHERE "entityType" = \'wallet\' AND "entityId" IN (SELECT id::text FROM wallets WHERE "brandId" = $1)',
      'DELETE FROM transactions WHERE "brandId" = $1',
      'DELETE FROM wallets WHERE "brandId" = $1',
    ])
      await dataSource.query(sql, [BRAND_A])
  }

  beforeAll(async () => {
    auth = await startAuth(authCalls)
    const { port } = auth.address() as AddressInfo
    Object.assign(process.env, {
      JWT_SECRET,
      COOKIE_SESSION,
      SERVICE_AUTH: `http://127.0.0.1:${port}`,
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
    const repo = (entity: any, conn: string) => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminTokenGiftController, TokenWalletController],
      providers: [
        AuditService,
        TokenWalletService,
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: JwtService, useValue: jwtService },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        ...[Wallet, AuditLog, TokenGiftNotice].flatMap((e) => [
          repo(e, 'DBWrite'),
          repo(e, 'DBRead'),
        ]),
        // R17: membership lives in backend-platform; it answers yes only for this user on this brand.
        {
          provide: ClientPlatformService,
          useValue: {
            canViewBrandCredit: jest.fn(
              async (u: string, b: string) => u === USER_ID && b === BRAND_A,
            ),
          },
        },
        // R17: these routes use @RequireSuperAdmin or brand membership, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser(JWT_SECRET))
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  beforeEach(async () => {
    authCalls.length = 0
    await clean()
  })

  afterAll(async () => {
    await clean()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    await new Promise((resolve) => auth?.close(resolve))
    process.env = { ...envSnapshot }
  })

  it.each([
    ['isSuperAdmin: true', { isSuperAdmin: true }],
    ["role: 'superadmin'", { role: 'superadmin' }],
  ])('an auto-login token with %s gets 403 on the gift and no wallet moves', async (_l, claims) => {
    // R15: red when validateViaAuth reads that claim from the auth answer again: the gift answers 201.
    const res = await http()
      .post(`/admin/token-wallets/${BRAND_A}/gifts`)
      .set('Authorization', `Bearer ${autoLogin(claims)}`)
      .send(giftBody('loc143-e1'))

    expect(res.status).toBe(HttpStatus.FORBIDDEN)
    expect(authCalls).toEqual([{ client: 'dropi' }])
    expect(await tokenWallet()).toBeNull()
  })

  it('an auto-login token without the claim still reads its brand token wallet with 200', async () => {
    // R15: red when the client path stops resolving the user (validateViaAuth returns null): 401.
    const res = await http()
      .get(`/token-wallet?brandId=${BRAND_A}`)
      .set('Authorization', `Bearer ${autoLogin({})}`)

    expect(res.status).toBe(HttpStatus.OK)
    expect(authCalls).toEqual([{ client: 'dropi' }])
    expect(res.body.data).toMatchObject({ brandId: BRAND_A, balance: 0 })
  })

  it('a super admin session cookie still gives the gift with 201 and the balance ends at 20', async () => {
    // R15: red when the JWT_SECRET session stops carrying isSuperAdmin: the gift answers 403.
    const session = new JwtService({ secret: JWT_SECRET }).sign({
      id: SUPERADMIN_ID,
      isSuperAdmin: true,
      brand: null,
    })

    const res = await http()
      .post(`/admin/token-wallets/${BRAND_A}/gifts`)
      .set('Cookie', `${COOKIE_SESSION}=${session}`)
      .send(giftBody('loc143-e3'))

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(authCalls).toHaveLength(0)
    expect(Number((await tokenWallet())!.balance)).toBe(20)
  })
})
