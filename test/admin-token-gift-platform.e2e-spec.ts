/**
 * The admin gift to a brand without a token wallet over HTTP against PostgreSQL, with the real
 * platform client asking a local stand-in for the brand owner: each platform failure has its code.
 */
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import { ServerResponse } from 'http'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AdminTokenGiftController } from '../src/admin/admin-token-gift.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import {
  BRAND_LOOKUP_UNAVAILABLE,
  BRAND_NOT_FOUND,
  BRAND_WITHOUT_OWNER,
  ClientPlatformService,
} from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { TokenGiftNotice } from '../src/wallet/entities/token-gift-notice.entity'
import { Wallet } from '../src/wallet/entities/wallet.entity'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { unknownServiceKeys } from './support/service-credential.double'
import { startUpstream, Upstream } from './support/token-debit.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'a3220000-0000-4000-8000-0000000000f1'
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc322-jwt-secret', 'e2e-loc322-server-token']

/** Platform's `GET /v1/brand/:id` answering `status` with `body`. */
const platformAnswers =
  (status: number, body: unknown): Upstream['reply'] =>
  (_path: string, res: ServerResponse) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  }

describe('Admin gift when platform cannot give the brand owner (PostgreSQL, LOC-322)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let platform: Upstream
  let superAdmin = ''

  const gift = () =>
    request(app.getHttpServer())
      .post(`/admin/token-wallets/${BRAND}/gifts`)
      .set('Authorization', `Bearer ${superAdmin}`)
      .send({ amount: 20, reason: 'Bonus', idempotencyKey: 'loc322-g1' })

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    await dataSource.query('DELETE FROM transactions WHERE "brandId" = $1', [BRAND])
    await dataSource.query('DELETE FROM wallets WHERE "brandId" = $1', [BRAND])
  }

  beforeAll(async () => {
    platform = await startUpstream(platformAnswers(200, {}))
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER, SERVICE_PLATFORM: platform.url })
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

    const jwtService = new JwtService({ secret: JWT_SECRET })
    superAdmin = jwtService.sign({ id: 'superadmin-loc322', isSuperAdmin: true, brand: null })
    const repo = (entity: unknown, conn: string) => ({
      provide: getRepositoryToken(entity as typeof Wallet, conn),
      useValue: dataSource.getRepository(entity as typeof Wallet),
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminTokenGiftController],
      providers: [
        AuditService,
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
        // R17: these routes use @RequireSuperAdmin, never a roles permission.
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
    await platform?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it.each([
    ['answers 503', 503, {}, HttpStatus.SERVICE_UNAVAILABLE, BRAND_LOOKUP_UNAVAILABLE],
    ['does not know the brand', 200, {}, HttpStatus.NOT_FOUND, BRAND_NOT_FOUND],
    [
      'knows the brand without an owner',
      200,
      { data: { owner: '' } },
      HttpStatus.UNPROCESSABLE_ENTITY,
      BRAND_WITHOUT_OWNER,
    ],
  ])('a gift while platform %s gets its code and opens no wallet', async (...row) => {
    // R27: three rows, so one mutation line per row; each one turns only its own row red.
    // Mutation (503): brandLookupFailure maps BRAND_LOOKUP_UNAVAILABLE to NOT_FOUND.
    // Mutation (404): brandLookupFailure maps BRAND_NOT_FOUND to UNPROCESSABLE_ENTITY.
    // Mutation (422): the last fail in brandLookupFailure answers SERVICE_UNAVAILABLE.
    const [, platformStatus, platformBody, status, code] = row
    platform.reply = platformAnswers(platformStatus, platformBody)

    const res = await gift()

    expect([res.status, res.body.code]).toEqual([status, code])
    expect(await dataSource.getRepository(Wallet).countBy({ brandId: BRAND })).toBe(0)
  })
})
