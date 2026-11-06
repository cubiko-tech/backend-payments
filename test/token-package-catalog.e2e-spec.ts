/**
 * The token package catalog over HTTP against PostgreSQL with the seed of AddTokenPackages: any
 * session reads the active packages; only a super admin session edits one, and the edit is audited.
 */
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AdminTokenPackageController } from '../src/admin/admin-token-package.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { TokenPackage } from '../src/wallet/entities/token-package.entity'
import { TokenPackageController } from '../src/wallet/token-package.controller'
import { TokenPackageService } from '../src/wallet/token-package.service'

dotenvConfig({ path: '.env' })

const SUPERADMIN_ID = 'superadmin-loc136'
const OPERATOR_ID = 'operator-loc136'
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc136-jwt-secret', 'e2e-loc136-server-token']
const SEED = { priceUsd: 50, purchasedTokens: 50, bonusTokens: 6, label: 'Escala', active: true }

describe('Token package catalog over HTTP (PostgreSQL, LOC-136)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let superAdmin = ''
  let operator = ''

  const http = () => request(app.getHttpServer())
  const packages = () => dataSource.getRepository(TokenPackage)
  const escala = () => packages().findOneByOrFail({ slug: 'escala' })
  const edit = async (body: Record<string, unknown>, token: string) =>
    http()
      .patch(`/admin/token-packages/${(await escala()).id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
  const auditsOf = async () =>
    dataSource
      .getRepository(AuditLog)
      .findBy({ entityType: 'token_package', entityId: (await escala()).id })
  const restoreSeed = async () => {
    if (!dataSource?.isInitialized) return
    await packages().update({ slug: 'escala' }, SEED)
    await dataSource.query(`DELETE FROM audit_log WHERE "entityType" = 'token_package'`)
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
      entities: [TokenPackage, AuditLog],
      synchronize: false,
    })
    await dataSource.initialize()

    const jwtService = new JwtService({ secret: JWT_SECRET })
    superAdmin = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })
    operator = jwtService.sign({ id: OPERATOR_ID, isSuperAdmin: false, brand: null })
    const moduleRef = await Test.createTestingModule({
      controllers: [TokenPackageController, AdminTokenPackageController],
      providers: [
        TokenPackageService,
        AuditService,
        Reflector,
        ApiAuthGuard,
        { provide: JwtService, useValue: jwtService },
        { provide: getRepositoryToken(TokenPackage, 'DBWrite'), useValue: packages() },
        ...['DBWrite', 'DBRead'].map((conn) => ({
          provide: getRepositoryToken(AuditLog, conn),
          useValue: dataSource.getRepository(AuditLog),
        })),
        // R17: these routes use @RequireSuperAdmin, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  beforeEach(restoreSeed)

  afterAll(async () => {
    await restoreSeed()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  it('lists the four seeded packages, cheapest first, to an operator and to the server token', async () => {
    // R15: red when the seed of AddTokenPackages changes a tier: the list no longer matches Ads.
    const asOperator = await http()
      .get('/token-packages')
      .set('Authorization', `Bearer ${operator}`)
    const asServer = await http()
      .get('/token-packages')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)

    expect([asOperator.status, asServer.status]).toEqual([HttpStatus.OK, HttpStatus.OK])
    const tiers = asOperator.body.data.map((p: any) => [
      p.priceUsd,
      p.purchasedTokens,
      p.bonusTokens,
    ])
    expect(tiers).toEqual([
      [10, 10, 0],
      [25, 25, 2],
      [50, 50, 6],
      [100, 100, 15],
    ])
  })

  it('CA3 a super admin changes the bonus of the USD 50 package, audited with its author', async () => {
    // R15: red when update stops saving the changes: the package still reads bonus 6.
    const res = await edit({ bonusTokens: 8 }, superAdmin)

    expect(res.status).toBe(HttpStatus.OK)
    expect(res.body.data).toMatchObject({ slug: 'escala', bonusTokens: 8 })
    expect(Number((await escala()).bonusTokens)).toBe(8)
    const [audit, ...rest] = await auditsOf()
    expect(rest).toHaveLength(0)
    expect(audit).toMatchObject({ action: 'token_package_updated', userId: SUPERADMIN_ID })
    expect(audit.changes).toMatchObject({ before: { bonusTokens: 6 }, after: { bonusTokens: 8 } })
  })

  it.each([
    ['an operator session', () => operator],
    ['the server token', () => ACCESS_SERVER],
  ])('CA3 %s gets 403 editing the catalog and the bonus stays at 6', async (_label, token) => {
    // R15: red when the controller drops @RequireSuperAdmin or @RequireSessionUser: it answers 200.
    const res = await edit({ bonusTokens: 8 }, token())

    expect(res.status).toBe(HttpStatus.FORBIDDEN)
    expect(Number((await escala()).bonusTokens)).toBe(6)
    expect(await auditsOf()).toHaveLength(0)
  })

  it('refuses a price under USD 10 with 400 and leaves the package as it was', async () => {
    // R15: red when the DTO drops @Min(MIN_PACKAGE_PRICE_USD): the CHECK constraint answers 500.
    const res = await edit({ priceUsd: 9.99 }, superAdmin)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(Number((await escala()).priceUsd)).toBe(50)
  })

  it.each(['priceUsd', 'purchasedTokens', 'bonusTokens'])(
    'LOC-139 refuses %s of 1e20 with 400 and leaves the package as it was',
    async (field) => {
      // R15: red when the DTO drops @Max(MAX_MONEY_AMOUNT) on that field: numeric overflow, 500.
      const res = await edit({ [field]: 1e20 }, superAdmin)

      expect(res.status).toBe(HttpStatus.BAD_REQUEST)
      const pkg = await escala()
      expect([pkg.priceUsd, pkg.purchasedTokens, pkg.bonusTokens].map(Number)).toEqual([50, 50, 6])
      expect(await auditsOf()).toHaveLength(0)
    },
  )

  it.each(['priceUsd', 'purchasedTokens', 'bonusTokens'])(
    'LOC-139 refuses %s of 1e-7 with 400 and leaves the package as it was',
    async (field) => {
      // R15: red when that field uses maxDecimalPlaces again: it throws on 1e-7 and answers 500.
      const res = await edit({ [field]: 1e-7 }, superAdmin)

      expect(res.status).toBe(HttpStatus.BAD_REQUEST)
      const pkg = await escala()
      expect([pkg.priceUsd, pkg.purchasedTokens, pkg.bonusTokens].map(Number)).toEqual([50, 50, 6])
      expect(await auditsOf()).toHaveLength(0)
    },
  )
})
