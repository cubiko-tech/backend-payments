import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import * as request from 'supertest'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { DropiProvider } from '../provider/dropi/dropi.provider'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { StripeProvider } from '../provider/stripe/stripe.provider'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequestException } from '../shared/exception/request.exception'
import { WebhookController } from '../webhook/webhook.controller'
import { WebhookService } from '../webhook/webhook.service'
import { BillingProfileController } from './billing-profile.controller'
import { BillingProfileService } from './billing-profile.service'
import { LegalDocumentService } from './legal-document.service'

describe('BillingProfileController and WebhookController admin operator authorization (LOC-47)', () => {
  const EXISTING_DOC_ID = '11111111-1111-4111-8111-111111111111'
  const NON_EXISTENT_DOC_ID = '99999999-9999-4999-8999-999999999999'
  const WEBHOOK_EVENT_ID = '22222222-2222-4222-8222-222222222222'
  const OWN_BRAND_ID = '33333333-3333-4333-8333-333333333333'
  const JWT_SECRET = 'loc47-test-jwt-secret'
  const SERVER_SECRET = 'loc47-test-server-secret'
  const CONFIO_ACCESS_TOKEN = 'loc47-confio-access-token'

  let app: INestApplication
  let jwtService: JwtService
  let userToken: string
  let superAdminToken: string
  let prevJwtSecret: string | undefined
  let prevAccessServer: string | undefined

  let billingProfileService: {
    get: jest.Mock
    create: jest.Mock
    update: jest.Mock
    getRequirements: jest.Mock
  }
  let legalDocumentService: {
    findByBrand: jest.Mock
    upsert: jest.Mock
    findAll: jest.Mock
    findPending: jest.Mock
    verify: jest.Mock
    reject: jest.Mock
  }
  let platformClient: { canViewBrandCredit: jest.Mock }
  let webhookService: {
    receive: jest.Mock
    getAllWebhooks: jest.Mock
    getFailedWebhooks: jest.Mock
    retryWebhook: jest.Mock
  }
  let rolesService: { checkPermission: jest.Mock }

  beforeAll(async () => {
    prevJwtSecret = process.env.JWT_SECRET
    prevAccessServer = process.env.ACCESS_SERVER
    process.env.JWT_SECRET = JWT_SECRET
    process.env.ACCESS_SERVER = SERVER_SECRET

    jwtService = new JwtService({ secret: JWT_SECRET })
    userToken = jwtService.sign({ id: 'user-regular', isSuperAdmin: false, brand: OWN_BRAND_ID })
    superAdminToken = jwtService.sign({ id: 'user-superadmin', isSuperAdmin: true, brand: null })

    billingProfileService = {
      get: jest.fn().mockResolvedValue({ data: { brandId: OWN_BRAND_ID } }),
      create: jest.fn().mockResolvedValue({ data: { brandId: OWN_BRAND_ID } }),
      update: jest.fn().mockResolvedValue({ data: { brandId: OWN_BRAND_ID } }),
      getRequirements: jest.fn().mockResolvedValue({ data: { country: 'CO' } }),
    }
    legalDocumentService = {
      findByBrand: jest
        .fn()
        .mockResolvedValue({ data: [{ id: EXISTING_DOC_ID, brandId: OWN_BRAND_ID }] }),
      upsert: jest.fn().mockResolvedValue({ data: { id: EXISTING_DOC_ID, brandId: OWN_BRAND_ID } }),
      findAll: jest.fn().mockResolvedValue({
        data: [{ id: EXISTING_DOC_ID, documentType: 'RUT', status: 'pending' }],
        total: 1,
        page: 1,
        perPage: 20,
      }),
      findPending: jest.fn().mockResolvedValue({
        data: [{ id: EXISTING_DOC_ID, status: 'pending' }],
        total: 1,
      }),
      verify: jest.fn().mockImplementation(async (id: string, verifiedBy: string) => {
        if (id === NON_EXISTENT_DOC_ID) {
          throw new RequestException(
            { message: 'Document not found', code: 'DOCUMENT_NOT_FOUND' },
            HttpStatus.NOT_FOUND,
          )
        }
        return { data: { id, status: 'verified', verifiedBy } }
      }),
      reject: jest
        .fn()
        .mockImplementation(async (id: string, verifiedBy: string, reason: string) => ({
          data: { id, status: 'rejected', verifiedBy, rejectionReason: reason },
        })),
    }
    platformClient = {
      canViewBrandCredit: jest.fn().mockResolvedValue(true),
    }
    webhookService = {
      receive: jest.fn().mockResolvedValue({ data: { received: true } }),
      getAllWebhooks: jest.fn().mockResolvedValue({
        data: [{ id: WEBHOOK_EVENT_ID, provider: 'confio', status: 'processed' }],
        stats: { total: 1 },
      }),
      getFailedWebhooks: jest.fn().mockResolvedValue({
        data: [{ id: WEBHOOK_EVENT_ID, provider: 'confio', status: 'failed' }],
      }),
      retryWebhook: jest.fn().mockResolvedValue({
        data: { id: WEBHOOK_EVENT_ID, status: 'retrying' },
      }),
    }
    rolesService = {
      checkPermission: jest.fn().mockResolvedValue(false),
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [BillingProfileController, WebhookController],
      providers: [
        ApiAuthGuard,
        Reflector,
        { provide: JwtService, useValue: jwtService },
        { provide: ClientRolesService, useValue: rolesService },
        { provide: BillingProfileService, useValue: billingProfileService },
        { provide: LegalDocumentService, useValue: legalDocumentService },
        { provide: ClientPlatformService, useValue: platformClient },
        { provide: WebhookService, useValue: webhookService },
        { provide: StripeProvider, useValue: { validateWebhookSignature: jest.fn() } },
        { provide: MercadoPagoProvider, useValue: { validateWebhookSignature: jest.fn() } },
        { provide: DropiProvider, useValue: { validateWebhookSignature: jest.fn() } },
        {
          provide: ConfioProvider,
          useValue: {
            validateWebhookSignature: (_raw: Buffer, token: string) =>
              token === CONFIO_ACCESS_TOKEN,
          },
        },
      ],
    }).compile()

    app = moduleRef.createNestApplication({ rawBody: true })
    await app.init()
  })

  afterAll(async () => {
    try {
      if (app) {
        await app.close()
      }
    } finally {
      process.env.JWT_SECRET = prevJwtSecret
      process.env.ACCESS_SERVER = prevAccessServer
    }
  })

  beforeEach(() => {
    jest.clearAllMocks()
    platformClient.canViewBrandCredit.mockResolvedValue(true)
  })

  it('rejects POST /billing-profile/admin/documents/:id/verify with 403 for non-superadmin', async () => {
    const nonExistentRes = await request(app.getHttpServer())
      .post(`/billing-profile/admin/documents/${NON_EXISTENT_DOC_ID}/verify`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ verifiedBy: 'user-regular' })

    expect(nonExistentRes.status).toBe(403)
    expect(legalDocumentService.verify).not.toHaveBeenCalled()

    const existingRes = await request(app.getHttpServer())
      .post(`/billing-profile/admin/documents/${EXISTING_DOC_ID}/verify`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ verifiedBy: 'user-regular' })

    expect(existingRes.status).toBe(403)
    expect(legalDocumentService.verify).not.toHaveBeenCalled()

    const superAdminRes = await request(app.getHttpServer())
      .post(`/billing-profile/admin/documents/${EXISTING_DOC_ID}/verify`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ verifiedBy: 'user-superadmin' })

    expect(superAdminRes.status).toBe(201)
    expect(legalDocumentService.verify).toHaveBeenCalledWith(EXISTING_DOC_ID, 'user-superadmin')
  })

  it('returns paginated documents on GET /billing-profile/admin/documents for superadmin', async () => {
    const allowedRes = await request(app.getHttpServer())
      .get('/billing-profile/admin/documents?page=1&perPage=20')
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(allowedRes.status).toBe(200)
    expect(allowedRes.body).toEqual({
      data: [{ id: EXISTING_DOC_ID, documentType: 'RUT', status: 'pending' }],
      total: 1,
      page: 1,
      perPage: 20,
    })
    expect(legalDocumentService.findAll).toHaveBeenCalledWith({
      status: undefined,
      country: undefined,
      documentType: undefined,
      page: 1,
      perPage: 20,
    })
    expect(legalDocumentService.findByBrand).not.toHaveBeenCalled()

    legalDocumentService.findAll.mockClear()

    const forbiddenRes = await request(app.getHttpServer())
      .get('/billing-profile/admin/documents')
      .set('Authorization', `Bearer ${userToken}`)

    expect(forbiddenRes.status).toBe(403)
    expect(legalDocumentService.findAll).not.toHaveBeenCalled()
    expect(legalDocumentService.findByBrand).not.toHaveBeenCalled()
  })

  it.each([
    ['billing-profile admin list', 'get', '/billing-profile/admin/documents', undefined],
    ['billing-profile admin pending', 'get', '/billing-profile/admin/documents/pending', undefined],
    [
      'billing-profile admin verify',
      'post',
      `/billing-profile/admin/documents/${EXISTING_DOC_ID}/verify`,
      { verifiedBy: 'user-superadmin' },
    ],
    [
      'billing-profile admin reject',
      'post',
      `/billing-profile/admin/documents/${EXISTING_DOC_ID}/reject`,
      { verifiedBy: 'user-superadmin', reason: 'illegible' },
    ],
    ['webhook admin events', 'get', '/webhook/admin/events', undefined],
    ['webhook admin failed', 'get', '/webhook/admin/failed', undefined],
    ['webhook admin retry', 'post', `/webhook/admin/${WEBHOOK_EVENT_ID}/retry`, {}],
  ] as const)(
    'returns 403 for non-superadmin without invoking service and 2xx for superadmin and ACCESS_SERVER on %s (%s %s)',
    async (_label, method, path, body) => {
      const forbiddenRes = await (request(app.getHttpServer()) as any)
        [method](path)
        .set('Authorization', `Bearer ${userToken}`)
        .send(body)

      expect(forbiddenRes.status).toBe(403)
      expect(legalDocumentService.findAll).not.toHaveBeenCalled()
      expect(legalDocumentService.findPending).not.toHaveBeenCalled()
      expect(legalDocumentService.verify).not.toHaveBeenCalled()
      expect(legalDocumentService.reject).not.toHaveBeenCalled()
      expect(webhookService.getAllWebhooks).not.toHaveBeenCalled()
      expect(webhookService.getFailedWebhooks).not.toHaveBeenCalled()
      expect(webhookService.retryWebhook).not.toHaveBeenCalled()

      const allowedRes = await (request(app.getHttpServer()) as any)
        [method](path)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(body)

      expect(allowedRes.status).toBeGreaterThanOrEqual(200)
      expect(allowedRes.status).toBeLessThan(300)

      const serverRes = await (request(app.getHttpServer()) as any)
        [method](path)
        .set('Authorization', `Bearer ${SERVER_SECRET}`)
        .send(body)

      expect(serverRes.status).toBeGreaterThanOrEqual(200)
      expect(serverRes.status).toBeLessThan(300)
    },
  )

  it('keeps incoming webhook POST /webhook/confio free of session guard (401 unsigned, 200 signed)', async () => {
    const unsignedRes = await request(app.getHttpServer()).post('/webhook/confio').send({})

    expect(unsignedRes.status).toBe(401)
    expect(unsignedRes.body).toMatchObject({
      message: 'Webhook de ConfioPagos rechazado',
    })
    expect(webhookService.receive).not.toHaveBeenCalled()

    const validWebhookRes = await request(app.getHttpServer())
      .post('/webhook/confio')
      .set('Authorization', `Bearer ${CONFIO_ACCESS_TOKEN}`)
      .send({
        event: 'payment.statusChanged',
        data: { name: 'stores/s1/payments/p1', status: 'FUNDED' },
        timestamp: 1768384800,
      })

    expect(validWebhookRes.status).toBe(200)
    expect(webhookService.receive).toHaveBeenCalledTimes(1)
  })

  it('continues serving GET /billing-profile/:brandId/documents for an authorized brand member', async () => {
    const res = await request(app.getHttpServer())
      .get(`/billing-profile/${OWN_BRAND_ID}/documents`)
      .set('Authorization', `Bearer ${userToken}`)

    expect(res.status).toBe(200)
    expect(legalDocumentService.findByBrand).toHaveBeenCalledWith(OWN_BRAND_ID)
  })
})
