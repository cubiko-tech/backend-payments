import { INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { AuditService } from '../audit/audit.service'
import { CountryBillingConfigService } from '../billing-profile/country-billing-config.service'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { ClientRolesService } from '../client/client-roles.service'
import { Invoice, InvoiceType } from '../invoice/entities/invoice.entity'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { DianController } from './dian.controller'
import { DianProvider } from './dian.interface'
import { DianService } from './dian.service'

describe('DianController operator authorization (LOC-78)', () => {
  const OWN_BRAND_ID = '11111111-1111-4111-8111-111111111111'
  const FOREIGN_BRAND_ID = '22222222-2222-4222-8222-222222222222'
  const UNSENT_INVOICE_ID = '33333333-3333-4333-8333-333333333333'
  const SENT_INVOICE_ID = '44444444-4444-4444-8444-444444444444'
  const NON_EXISTENT_INVOICE_ID = '99999999-9999-4999-8999-999999999999'
  const USER_ID = '55555555-5555-4555-8555-555555555555'
  const SUPERADMIN_ID = '66666666-6666-4666-8666-666666666666'
  const EXISTING_CUFE = 'cufe-existing-0002'
  const JWT_SECRET = 'loc78-test-jwt-secret'
  const SERVER_SECRET = 'loc78-test-server-secret'

  let app: INestApplication
  let jwtService: JwtService
  let userToken: string
  let superAdminToken: string
  let prevJwtSecret: string | undefined
  let prevAccessServer: string | undefined

  let invoiceRepo: {
    findOne: jest.Mock
    save: jest.Mock
  }
  let billingProfileRepo: {
    findOne: jest.Mock
  }
  let countryConfig: {
    getElectronicInvoiceProvider: jest.Mock
    requiresElectronicInvoice: jest.Mock
  }
  let auditService: {
    log: jest.Mock
  }
  let rolesService: {
    checkPermission: jest.Mock
  }
  let providerMock: jest.Mocked<DianProvider>

  beforeAll(async () => {
    prevJwtSecret = process.env.JWT_SECRET
    prevAccessServer = process.env.ACCESS_SERVER
    process.env.JWT_SECRET = JWT_SECRET
    process.env.ACCESS_SERVER = SERVER_SECRET

    jwtService = new JwtService({ secret: JWT_SECRET })
    userToken = jwtService.sign({ id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID })
    superAdminToken = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })

    invoiceRepo = {
      findOne: jest.fn(),
      save: jest.fn(async (entity) => entity),
    }
    billingProfileRepo = {
      findOne: jest.fn().mockResolvedValue(null),
    }
    countryConfig = {
      getElectronicInvoiceProvider: jest.fn().mockResolvedValue('mock'),
      requiresElectronicInvoice: jest.fn().mockResolvedValue(true),
    }
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
    }
    rolesService = {
      checkPermission: jest.fn().mockResolvedValue(false),
    }
    providerMock = {
      name: 'mock',
      sendInvoice: jest.fn().mockResolvedValue({
        success: true,
        cufe: 'cufe-mock-0001',
        status: 'accepted',
        trackingId: 'mock-track-1',
        dianMessage: 'Accepted (mock)',
      }),
      sendCreditNote: jest.fn().mockResolvedValue({
        success: true,
        cufe: 'cufe-mock-cn-0001',
        status: 'accepted',
      }),
      getStatus: jest.fn().mockResolvedValue({
        status: 'accepted',
        cufe: EXISTING_CUFE,
        dianMessage: 'Accepted (mock)',
      }),
      isConfigured: jest.fn().mockReturnValue(true),
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [DianController],
      providers: [
        DianService,
        Reflector,
        ApiAuthGuard,
        { provide: JwtService, useValue: jwtService },
        { provide: ClientRolesService, useValue: rolesService },
        { provide: getRepositoryToken(Invoice, 'DBWrite'), useValue: invoiceRepo },
        { provide: getRepositoryToken(BillingProfile, 'DBRead'), useValue: billingProfileRepo },
        { provide: CountryBillingConfigService, useValue: countryConfig },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile()

    const dianService = moduleRef.get(DianService) as any
    dianService.providers.set('mock', providerMock)
    dianService.defaultProvider = providerMock

    app = moduleRef.createNestApplication()
    await app.init()
  })

  beforeEach(() => {
    jest.clearAllMocks()

    countryConfig.getElectronicInvoiceProvider.mockResolvedValue('mock')
    countryConfig.requiresElectronicInvoice.mockResolvedValue(true)
    billingProfileRepo.findOne.mockResolvedValue(null)
    auditService.log.mockResolvedValue(undefined)
    providerMock.isConfigured.mockReturnValue(true)
    providerMock.sendInvoice.mockResolvedValue({
      success: true,
      cufe: 'cufe-mock-0001',
      status: 'accepted',
      trackingId: 'mock-track-1',
      dianMessage: 'Accepted (mock)',
    })
    providerMock.getStatus.mockResolvedValue({
      status: 'accepted',
      cufe: EXISTING_CUFE,
      dianMessage: 'Accepted (mock)',
    })

    invoiceRepo.findOne.mockImplementation(async ({ where }: any) => {
      if (where?.id === UNSENT_INVOICE_ID) {
        return {
          id: UNSENT_INVOICE_ID,
          brandId: FOREIGN_BRAND_ID,
          invoiceNumber: 'CK-0001',
          type: InvoiceType.INVOICE,
          dianCufe: null,
          billingProfileId: null,
          subtotal: 100,
          taxTotal: 19,
          total: 119,
          currency: 'COP',
          items: [],
          createdAt: new Date('2026-10-30T00:00:00.000Z'),
        }
      }
      if (where?.id === SENT_INVOICE_ID) {
        return {
          id: SENT_INVOICE_ID,
          brandId: FOREIGN_BRAND_ID,
          invoiceNumber: 'CK-0002',
          type: InvoiceType.INVOICE,
          dianCufe: EXISTING_CUFE,
          billingProfileId: null,
          subtotal: 100,
          taxTotal: 19,
          total: 119,
          currency: 'COP',
          items: [],
          createdAt: new Date('2026-10-30T00:00:00.000Z'),
        }
      }
      return null
    })
  })

  afterAll(async () => {
    if (app) {
      await app.close()
    }
    if (prevJwtSecret === undefined) {
      delete process.env.JWT_SECRET
    } else {
      process.env.JWT_SECRET = prevJwtSecret
    }
    if (prevAccessServer === undefined) {
      delete process.env.ACCESS_SERVER
    } else {
      process.env.ACCESS_SERVER = prevAccessServer
    }
  })

  it('rejects POST /dian/send/:invoiceId with 403 for a non-superadmin session without calling provider', async () => {
    // Mutation: removing @RequireSuperAdmin() from DianController.sendInvoice lets the session
    // call the provider and return 201 Created, turning this assertion red.
    const res = await request(app.getHttpServer())
      .post(`/dian/send/${UNSENT_INVOICE_ID}`)
      .set('Authorization', `Bearer ${userToken}`)

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ error: 'forbidden', code: 'forbidden' })
    expect(providerMock.sendInvoice).not.toHaveBeenCalled()
    expect(invoiceRepo.findOne).not.toHaveBeenCalled()
    expect(invoiceRepo.save).not.toHaveBeenCalled()
  })

  it('rejects GET /dian/status/:invoiceId with 403 for a non-superadmin session without calling provider', async () => {
    const res = await request(app.getHttpServer())
      .get(`/dian/status/${SENT_INVOICE_ID}`)
      .set('Authorization', `Bearer ${userToken}`)

    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ error: 'forbidden', code: 'forbidden' })
    expect(providerMock.getStatus).not.toHaveBeenCalled()
    expect(invoiceRepo.findOne).not.toHaveBeenCalled()
  })

  it('allows superadmin operator past the guard on POST /dian/send/:invoiceId for missing invoice', async () => {
    const res = await request(app.getHttpServer())
      .post(`/dian/send/${NON_EXISTENT_INVOICE_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(res.status).not.toBe(403)
    expect(res.status).not.toBe(401)
    expect(invoiceRepo.findOne).toHaveBeenCalledWith({
      where: { id: NON_EXISTENT_INVOICE_ID },
      relations: ['items'],
    })
    expect(providerMock.sendInvoice).not.toHaveBeenCalled()
  })

  it('allows superadmin operator and service token on POST /dian/send and GET /dian/status', async () => {
    const operatorSendRes = await request(app.getHttpServer())
      .post(`/dian/send/${UNSENT_INVOICE_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(operatorSendRes.status).toBe(201)
    expect(operatorSendRes.body).toMatchObject({
      success: true,
      cufe: 'cufe-mock-0001',
      status: 'accepted',
    })
    expect(providerMock.sendInvoice).toHaveBeenCalledTimes(1)

    const serverSendRes = await request(app.getHttpServer())
      .post(`/dian/send/${UNSENT_INVOICE_ID}`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(serverSendRes.status).toBe(201)
    expect(providerMock.sendInvoice).toHaveBeenCalledTimes(2)

    const operatorStatusRes = await request(app.getHttpServer())
      .get(`/dian/status/${SENT_INVOICE_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(operatorStatusRes.status).toBe(200)
    expect(operatorStatusRes.body).toMatchObject({
      status: 'accepted',
      cufe: EXISTING_CUFE,
    })
    expect(providerMock.getStatus).toHaveBeenCalledWith(EXISTING_CUFE)

    const serverStatusRes = await request(app.getHttpServer())
      .get(`/dian/status/${SENT_INVOICE_ID}`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(serverStatusRes.status).toBe(200)
    expect(providerMock.getStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps GET /dian/configured accessible to an authenticated non-superadmin session', async () => {
    const res = await request(app.getHttpServer())
      .get('/dian/configured')
      .set('Authorization', `Bearer ${userToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { configured: true } })
    expect(providerMock.isConfigured).toHaveBeenCalledTimes(1)
  })
})
