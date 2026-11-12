/**
 * ROAX Ads' service credential over HTTP against PostgreSQL (LOC-173): issued, rotated and switched
 * by a super admin, and the only caller a recharge route lets in. The recharge routes are born in
 * LOC-174/175, so a probe controller here carries the same mark they will.
 * R6: one responsibility, who a recharge route lets in, behind one app; a split would copy its setup.
 */
import { Controller, HttpCode, HttpStatus, INestApplication, Post, UseGuards } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { createHash } from 'crypto'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource } from 'typeorm'

import { AdminServiceCredentialController } from '../src/admin/admin-service-credential.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { ServiceCredential } from '../src/shared/auth/entities/service-credential.entity'
import {
  RequireServiceClient,
  ROAX_ADS_CLIENT,
} from '../src/shared/auth/require-permission.decorator'
import { ServiceCredentialService } from '../src/shared/auth/service-credential.service'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { TokenWalletController } from '../src/wallet/token-wallet.controller'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { failNextAuditWrite } from './support/audit-failure.fixture'

dotenvConfig({ path: '.env' })

const BRAND_A = 'a1730000-0000-4000-8000-0000000000e2'
const SUPERADMIN_ID = 'superadmin-loc173'
const [JWT_SECRET, ACCESS_SERVER] = ['e2e-loc173-jwt-secret', 'e2e-loc173-server-token']

/** Stands for the recharge routes of LOC-174/175, with the mark they carry. */
@Controller('e2e-recharge')
@UseGuards(ApiAuthGuard)
@RequireServiceClient(ROAX_ADS_CLIENT)
class RechargeProbeController {
  @Post() create() {
    return { data: 'created' }
  }

  @Post(':id/result') @HttpCode(HttpStatus.OK) report() {
    return { data: 'reported' }
  }
}

describe('ROAX Ads service credential on recharge routes (PostgreSQL, LOC-173)', () => {
  const envSnapshot = { ...process.env }
  let app: INestApplication
  let dataSource: DataSource
  let superAdmin = ''
  let brandUser = ''
  // R17: no route here reaches platform but the token wallet one, which must refuse before asking.
  const platform = { canViewBrandCredit: jest.fn().mockResolvedValue(true) }

  const http = () => request(app.getHttpServer())
  const bearer = (token: string) => `Bearer ${token}`
  const issue = (body: unknown = { client: ROAX_ADS_CLIENT }, token = superAdmin) =>
    http()
      .post('/admin/service-credentials')
      .set('Authorization', bearer(token))
      .send(body as object)
  const rotate = (client = ROAX_ADS_CLIENT, token = superAdmin) =>
    http().post(`/admin/service-credentials/${client}/rotate`).set('Authorization', bearer(token))
  const setActive = (body: unknown, client = ROAX_ADS_CLIENT, token = superAdmin) =>
    http()
      .patch(`/admin/service-credentials/${client}`)
      .set('Authorization', bearer(token))
      .send(body as object)
  const createRecharge = (token: string) =>
    http().post('/e2e-recharge').set('Authorization', bearer(token)).send({})
  const reportRecharge = (token: string) =>
    http().post('/e2e-recharge/r1/result').set('Authorization', bearer(token)).send({})
  const issuedKey = async (): Promise<string> => (await issue()).body.data.key
  const rows = () => dataSource.getRepository(ServiceCredential).find()
  const audits = () =>
    dataSource.getRepository(AuditLog).find({
      where: { entityType: 'service_credential' },
      order: { createdAt: 'ASC' },
    })

  const clean = async () => {
    if (!dataSource?.isInitialized) return
    await dataSource.query(`DELETE FROM audit_log WHERE "entityType" = 'service_credential'`)
    await dataSource.query('DELETE FROM service_credentials')
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
      entities: [ServiceCredential, AuditLog],
      synchronize: false,
    })
    await dataSource.initialize()

    const jwtService = new JwtService({ secret: JWT_SECRET })
    superAdmin = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })
    brandUser = jwtService.sign({ id: 'user-loc173', isSuperAdmin: false, brand: BRAND_A })
    const repo = (entity: typeof ServiceCredential | typeof AuditLog, conn: string) => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })
    const moduleRef = await Test.createTestingModule({
      controllers: [
        AdminServiceCredentialController,
        RechargeProbeController,
        TokenWalletController,
      ],
      providers: [
        AuditService,
        ServiceCredentialService,
        Reflector,
        ApiAuthGuard,
        { provide: JwtService, useValue: jwtService },
        repo(ServiceCredential, 'DBWrite'),
        repo(AuditLog, 'DBWrite'),
        repo(AuditLog, 'DBRead'),
        { provide: ClientPlatformService, useValue: platform },
        // R17: the token wallet route must answer before the wallet is read; this only builds it.
        { provide: TokenWalletService, useValue: { getOrCreate: jest.fn().mockResolvedValue({}) } },
        // R17: these routes use @RequireSuperAdmin or the service mark, never a roles permission.
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

  it('CA3 issuing stores only the hash of the key, shown once, and audits without it', async () => {
    // R15: red when create stores anything but the SHA-256 of the key it hands back.
    const res = await issue()

    expect(res.status).toBe(HttpStatus.CREATED)
    const key: string = res.body.data.key
    expect(key).toMatch(/^psk\.roax-ads\.[A-Za-z0-9_-]{43}$/)
    const [row, ...others] = await rows()
    expect(others).toHaveLength(0)
    expect(row.keyHash).toBe(createHash('sha256').update(key).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(key.split('.')[2])
    const [audit] = await audits()
    expect([audit.action, audit.userId]).toEqual(['service_credential_created', SUPERADMIN_ID])
    expect(JSON.stringify(audit)).not.toContain(key.split('.')[2])
    expect(JSON.stringify(audit)).not.toContain(row.keyHash)
  })

  it('CA3 the ROAX Ads credential creates (201) and reports (200) a recharge', async () => {
    // R15: red when the guard stops resolving service keys: both answer 401.
    const key = await issuedKey()

    expect((await createRecharge(key)).status).toBe(HttpStatus.CREATED)
    expect((await reportRecharge(key)).status).toBe(HttpStatus.OK)
  })

  it('CA3 the general server token gets 403 creating and reporting a recharge', async () => {
    // R15: red when the route mark is not enforced: ACCESS_SERVER is super admin and gets 201.
    expect((await createRecharge(ACCESS_SERVER)).status).toBe(HttpStatus.FORBIDDEN)
    expect((await reportRecharge(ACCESS_SERVER)).status).toBe(HttpStatus.FORBIDDEN)
  })

  it('CA3 a brand user and a super admin get 403 creating and reporting a recharge', async () => {
    // R15: red when the route mark is not enforced: the super admin session gets 201.
    const statuses: number[] = []
    for (const token of [brandUser, superAdmin]) {
      statuses.push((await createRecharge(token)).status, (await reportRecharge(token)).status)
    }

    expect(statuses).toEqual(Array(4).fill(HttpStatus.FORBIDDEN))
  })

  it('CA3 the ROAX Ads credential gets 403 on the admin routes and changes nothing', async () => {
    // R15: red only when the identity is super admin and the default-closed check is gone: 201.
    const key = await issuedKey()

    const results = [
      await issue({ client: 'other-service' }, key),
      await rotate(ROAX_ADS_CLIENT, key),
      await setActive({ active: false }, ROAX_ADS_CLIENT, key),
    ]

    expect(results.map((r) => r.status)).toEqual(Array(3).fill(HttpStatus.FORBIDDEN))
    expect((await rows()).map((r) => [r.client, r.active])).toEqual([[ROAX_ADS_CLIENT, true]])
  })

  it('CA3 the ROAX Ads credential gets 403 on a plain user route without asking platform', async () => {
    // R15: red when the default-closed check is gone: the token wallet answers 200.
    const key = await issuedKey()

    const res = await http()
      .get(`/token-wallet?brandId=${BRAND_A}`)
      .set('Authorization', bearer(key))

    expect(res.status).toBe(HttpStatus.FORBIDDEN)
    expect(platform.canViewBrandCredit).not.toHaveBeenCalled()
  })

  it('CA3 after a rotation the previous key gets 401 and the new one 201', async () => {
    // R15: red when rotate keeps the old hash: the previous key still gets 201.
    const previous = await issuedKey()

    const rotated = await rotate()
    const next: string = rotated.body.data.key

    expect(rotated.status).toBe(HttpStatus.CREATED)
    expect(next).not.toBe(previous)
    expect((await createRecharge(previous)).status).toBe(HttpStatus.UNAUTHORIZED)
    expect((await createRecharge(next)).status).toBe(HttpStatus.CREATED)
    expect((await audits()).map((a) => a.action)).toEqual([
      'service_credential_created',
      'service_credential_rotated',
    ])
  })

  it('CA3 a deactivated credential gets 401, and E4 reactivating lets the same key in', async () => {
    // R15: red when authenticate ignores active: the deactivated key gets 201.
    const key = await issuedKey()

    const off = await setActive({ active: false })
    const whileOff = await createRecharge(key)
    await setActive({ active: true })
    const whileOn = await createRecharge(key)

    expect(off.status).toBe(HttpStatus.OK)
    expect(off.body.data).toEqual({
      id: expect.any(String),
      client: ROAX_ADS_CLIENT,
      active: false,
    })
    expect([whileOff.status, whileOn.status]).toEqual([HttpStatus.UNAUTHORIZED, HttpStatus.CREATED])
  })

  it('a key with a valid shape for an unknown client gets 401', async () => {
    // R15: red when authenticate stops refusing a missing row: it answers 500.
    await issuedKey()

    const res = await createRecharge(`psk.ghost-client.${'A'.repeat(43)}`)

    expect(res.status).toBe(HttpStatus.UNAUTHORIZED)
  })

  it('E1 two rotations at once leave exactly one of their keys working', async () => {
    // R15: red when rotate hands back a key other than the one it stored: both keys get 401.
    await issuedKey()

    const [a, b] = await Promise.all([rotate(), rotate()])
    const [withA, withB] = await Promise.all([
      createRecharge(a.body.data.key),
      createRecharge(b.body.data.key),
    ])

    expect([a.status, b.status]).toEqual([HttpStatus.CREATED, HttpStatus.CREATED])
    expect([withA.status, withB.status].sort()).toEqual([
      HttpStatus.CREATED,
      HttpStatus.UNAUTHORIZED,
    ])
  })

  it('E2 two issues for the same client at once: one 201, the other 409, one row, one audit', async () => {
    // R15: red when the unique violation is not mapped: the second answers 500.
    const results = await Promise.all([issue(), issue()])

    expect(results.map((r) => r.status).sort()).toEqual([HttpStatus.CREATED, HttpStatus.CONFLICT])
    expect(results.find((r) => r.status === HttpStatus.CONFLICT)!.body.code).toBe(
      'SERVICE_CREDENTIAL_EXISTS',
    )
    expect(await rows()).toHaveLength(1)
    expect(await audits()).toHaveLength(1)
  })

  it('E3 a rotation whose audit write fails keeps the previous key and its single audit row', async () => {
    // R15: red when the hash commits before the audit is written: the previous key gets 401.
    const previous = await issuedKey()
    failNextAuditWrite()

    const failed = await rotate()

    expect(failed.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect((await createRecharge(previous)).status).toBe(HttpStatus.CREATED)
    expect((await audits()).map((a) => a.action)).toEqual(['service_credential_created'])
  })

  it('E3 an issue whose audit write fails stores nothing, and its retry issues one', async () => {
    // R15: red when the row commits before the audit: the retry answers 409.
    failNextAuditWrite()

    const failed = await issue()
    const retried = await issue()

    expect([failed.status, retried.status]).toEqual([
      HttpStatus.INTERNAL_SERVER_ERROR,
      HttpStatus.CREATED,
    ])
    expect(await rows()).toHaveLength(1)
  })

  it('rotating or switching a client without a credential answers 404', async () => {
    const results = [
      await rotate('ghost-client'),
      await setActive({ active: false }, 'ghost-client'),
    ]

    expect(results.map((r) => [r.status, r.body.code])).toEqual([
      [HttpStatus.NOT_FOUND, 'SERVICE_CREDENTIAL_NOT_FOUND'],
      [HttpStatus.NOT_FOUND, 'SERVICE_CREDENTIAL_NOT_FOUND'],
    ])
  })

  it.each([
    ['1e-7 (exponent form)', { client: 1e-7 }],
    ['a number', { client: 42 }],
    ['null', { client: null }],
    ['uppercase and underscore', { client: 'Roax_Ads' }],
    ['51 characters (over the column)', { client: 'a'.repeat(51) }],
    ['no client', {}],
    ['an extra field', { client: 'other-service', keyHash: '0'.repeat(64) }],
  ])('issuing with client as %s answers 400 and stores nothing', async (_label, body) => {
    // R15: red when ServiceClientDto drops @IsString and @Matches: it answers 201 or 500.
    const res = await issue(body)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(await rows()).toHaveLength(0)
  })

  it.each([
    ['the string "false"', { active: 'false' }],
    ['null', { active: null }],
    ['1e-7 (exponent form)', { active: 1e-7 }],
    ['no field', {}],
  ])('switching with active as %s answers 400 and the credential stays on', async (_l, body) => {
    // R15: red when SetServiceCredentialActiveDto drops @IsBoolean: it answers 200 or 500.
    const key = await issuedKey()

    const res = await setActive(body)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect((await createRecharge(key)).status).toBe(HttpStatus.CREATED)
  })

  it('a client in the path out of the pattern answers 400', async () => {
    // R15: red when ServiceClientDto drops @Matches: the rotation looks the client up, 404.
    const res = await rotate('A'.repeat(51))

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
  })
})
