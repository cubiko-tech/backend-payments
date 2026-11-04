import { ExecutionContext, INestApplication } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { ClientPlatformService } from '../client/client-platform.service'
import { Invoice } from '../invoice/entities/invoice.entity'
import { InvoiceItem } from '../invoice/entities/invoiceItem.entity'
import { InvoicePdfService } from '../invoice/invoice-pdf.service'
import { InvoiceController } from '../invoice/invoice.controller'
import { InvoiceService } from '../invoice/invoice.service'
import { PaymentController } from '../payment/payment.controller'
import { PaymentService } from '../payment/payment.service'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { DropiProvider } from '../provider/dropi/dropi.provider'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { StripeProvider } from '../provider/stripe/stripe.provider'
import { RefundController } from '../refund/refund.controller'
import { RefundService } from '../refund/refund.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { GlobalValidationPipe } from '../shared/validation/global-validation-pipe'
import { WalletController } from '../wallet/wallet.controller'
import { WalletService } from '../wallet/wallet.service'
import { WebhookController } from '../webhook/webhook.controller'
import { WebhookService } from '../webhook/webhook.service'
import { BillingProfileController } from './billing-profile.controller'
import { BillingProfileService } from './billing-profile.service'
import { BrandLegalDocument } from './entities/brandLegalDocument.entity'
import { LegalDocumentService } from './legal-document.service'

const VALID_UUID = '11111111-1111-4111-8111-111111111111'
const BRAND_UUID = '22222222-2222-4222-8222-222222222222'
const USER_UUID = '33333333-3333-4333-8333-333333333333'

describe('List query caps, document HTTPS URL, and UUID params (LOC-123)', () => {
  let app: INestApplication

  // R17: Repo and service doubles record TypeORM `take` options without opening PostgreSQL.
  const repoTakeSpy = jest.fn()
  const documentWriteRepo = {
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((x) => ({ id: VALID_UUID, ...x })),
    save: jest.fn(async (d) => d),
  }
  const documentReadRepo = {
    find: jest.fn(async (opts) => {
      repoTakeSpy(opts)
      return []
    }),
  }
  const invoiceReadRepo = {
    findAndCount: jest.fn(async (opts) => {
      repoTakeSpy(opts)
      return [[], 0]
    }),
  }
  const refundService = {
    findByBrand: jest.fn(async (_brandId: string, filters?: { limit?: number }) => {
      repoTakeSpy({ take: filters?.limit || 20 })
      return { data: [], total: 0 }
    }),
  }
  const walletService = {
    findById: jest.fn().mockResolvedValue({ data: { id: VALID_UUID, brandId: BRAND_UUID } }),
    getTransactions: jest.fn(async (_id: string, filters?: { limit?: number }) => {
      repoTakeSpy({ take: filters?.limit || 20 })
      return { data: [], total: 0 }
    }),
  }
  const paymentService = {
    getPaymentsByBrand: jest.fn(async (_brandId: string, filters?: { limit?: number }) => {
      repoTakeSpy({ take: filters?.limit || 20 })
      return { data: [], total: 0 }
    }),
  }
  const webhookService = {
    getAllWebhooks: jest.fn(async (filters?: { limit?: number }) => {
      repoTakeSpy({ take: filters?.limit || 100 })
      return { data: [], stats: { total: 0 } }
    }),
    getFailedWebhooks: jest.fn(async (limit = 50) => {
      repoTakeSpy({ take: limit })
      return { data: [] }
    }),
    retryWebhook: jest.fn().mockResolvedValue({ data: { id: VALID_UUID } }),
  }
  const platformClient = { canViewBrandCredit: jest.fn().mockResolvedValue(true) }

  beforeAll(async () => {
    // R17: Guard double injects a superAdmin principal so requests reach controller pipes directly.
    const allowGuard = {
      canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest()
        req.user = { id: USER_UUID, isSuperAdmin: true, brand: BRAND_UUID }
        return true
      },
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [
        BillingProfileController,
        WebhookController,
        RefundController,
        InvoiceController,
        WalletController,
        PaymentController,
      ],
      providers: [
        LegalDocumentService,
        InvoiceService,
        { provide: BillingProfileService, useValue: {} },
        { provide: InvoicePdfService, useValue: {} },
        { provide: getRepositoryToken(BrandLegalDocument, 'DBWrite'), useValue: documentWriteRepo },
        { provide: getRepositoryToken(BrandLegalDocument, 'DBRead'), useValue: documentReadRepo },
        { provide: getRepositoryToken(Invoice, 'DBWrite'), useValue: {} },
        { provide: getRepositoryToken(Invoice, 'DBRead'), useValue: invoiceReadRepo },
        { provide: getRepositoryToken(InvoiceItem, 'DBWrite'), useValue: {} },
        { provide: getDataSourceToken('DBWrite'), useValue: {} },
        { provide: RefundService, useValue: refundService },
        { provide: WalletService, useValue: walletService },
        { provide: PaymentService, useValue: paymentService },
        { provide: WebhookService, useValue: webhookService },
        { provide: ClientPlatformService, useValue: platformClient },
        { provide: StripeProvider, useValue: {} },
        { provide: MercadoPagoProvider, useValue: {} },
        { provide: DropiProvider, useValue: {} },
        { provide: ConfioProvider, useValue: {} },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue(allowGuard)
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(new GlobalValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    ['GET /invoice', `/invoice?brandId=${BRAND_UUID}&limit=100000`],
    ['GET /refund', `/refund?brandId=${BRAND_UUID}&limit=100000`],
    ['GET /wallet/:id/transactions', `/wallet/${VALID_UUID}/transactions?limit=100000`],
    ['GET /payment', `/payment?brandId=${BRAND_UUID}&limit=100000`],
    [
      'GET /billing-profile/admin/documents/pending',
      '/billing-profile/admin/documents/pending?limit=100000',
    ],
    ['GET /webhook/admin/events', '/webhook/admin/events?limit=100000'],
    ['GET /webhook/admin/failed', '/webhook/admin/failed?limit=100000'],
  ])(
    'rejects %s with limit=100000 with 400 before passing take=100000 to query',
    async (_label, url) => {
      // R15 (Mutation): Remove @Max(100) from list DTO -> passes take: 100000 to repoTakeSpy.
      const res = await request(app.getHttpServer()).get(url)

      expect(repoTakeSpy).not.toHaveBeenCalledWith(expect.objectContaining({ take: 100000 }))
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('INVALID_REQUEST')
    },
  )

  it('allows valid list queries with limit <= 100 and transforms numeric query parameters', async () => {
    // R15 (Mutation): Omit brandId or @Type(() => Number) on ListInvoicesQueryDto -> returns 400.
    const res = await request(app.getHttpServer()).get(
      `/invoice?brandId=${BRAND_UUID}&page=1&limit=25`,
    )

    expect(res.status).toBe(200)
    expect(repoTakeSpy).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }))
  })

  it('rejects non-HTTPS documentUrl on POST /billing-profile/:brandId/documents with 400 and allows https://', async () => {
    // R15 (Mutation): Relax @IsUrl({ protocols: ['https'] }) -> http:// URL is saved.
    for (const badUrl of [
      'http://cdn.example.com/rut.pdf',
      'ftp://cdn.example.com/rut.pdf',
      'javascript:alert(1)',
      'not-a-url',
    ]) {
      const badRes = await request(app.getHttpServer())
        .post(`/billing-profile/${BRAND_UUID}/documents`)
        .send({ country: 'CO', documentType: 'RUT', documentUrl: badUrl })

      expect(badRes.status).toBe(400)
      expect(badRes.body.code).toBe('INVALID_REQUEST')
    }
    expect(documentWriteRepo.save).not.toHaveBeenCalled()

    const okRes = await request(app.getHttpServer())
      .post(`/billing-profile/${BRAND_UUID}/documents`)
      .send({
        country: 'CO',
        documentType: 'RUT',
        documentUrl: 'https://cdn.example.com/rut.pdf',
      })

    expect(okRes.status).toBe(201)
    expect(documentWriteRepo.save).toHaveBeenCalledTimes(1)
  })

  it('validates UUID params and body DTOs on billing-profile document and webhook retry routes', async () => {
    // R15 (Mutation): Remove ParseUUIDPipe or RejectLegalDocumentDto -> bad input reaches service.
    const badVerifyUuid = await request(app.getHttpServer())
      .post('/billing-profile/admin/documents/not-a-uuid/verify')
      .send({ verifiedBy: 'admin' })
    expect(badVerifyUuid.status).toBe(400)

    const badRejectUuid = await request(app.getHttpServer())
      .post('/billing-profile/admin/documents/not-a-uuid/reject')
      .send({ reason: 'expired' })
    expect(badRejectUuid.status).toBe(400)

    const badRejectBody = await request(app.getHttpServer())
      .post(`/billing-profile/admin/documents/${VALID_UUID}/reject`)
      .send({ verifiedBy: 'admin', reason: '' })
    expect(badRejectBody.status).toBe(400)
    expect(badRejectBody.body.code).toBe('INVALID_REQUEST')

    const badGetDocsUuid = await request(app.getHttpServer()).get(
      '/billing-profile/not-a-uuid/documents',
    )
    expect(badGetDocsUuid.status).toBe(400)

    const badUploadUuid = await request(app.getHttpServer())
      .post('/billing-profile/not-a-uuid/documents')
      .send({
        country: 'CO',
        documentType: 'RUT',
        documentUrl: 'https://cdn.example.com/rut.pdf',
      })
    expect(badUploadUuid.status).toBe(400)

    const badWebhookRetryUuid = await request(app.getHttpServer()).post(
      '/webhook/admin/not-a-uuid/retry',
    )
    expect(badWebhookRetryUuid.status).toBe(400)
    expect(webhookService.retryWebhook).not.toHaveBeenCalled()
  })
})
