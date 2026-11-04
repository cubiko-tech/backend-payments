import { INestApplication } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'

import { AuditService } from '../audit/audit.service'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { DianService } from '../dian/dian.service'
import { EventBusService } from '../event-bus/event-bus.service'
import { InvoiceService } from '../invoice/invoice.service'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payment/entities/payment.entity'
import { PaymentAttempt } from '../payment/entities/paymentAttempt.entity'
import { ProviderConfigService } from '../provider/provider-config.service'
import { ProviderFactory } from '../provider/provider.factory'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../shared/validation/global-validation-pipe'
import { EnterprisePricingService } from '../subscription/enterprise-pricing.service'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { SubscriptionService } from '../subscription/subscription.service'
import { TaxService } from '../tax/tax.service'
import { WalletService } from '../wallet/wallet.service'
import { WebhookService } from '../webhook/webhook.service'
import { CheckoutController } from './checkout.controller'
import { CheckoutService } from './checkout.service'

const PAYMENT_ID = '11111111-2222-4333-8444-555555555555'
const BRAND_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const BRAND_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const COOKIE_NAME = 'cubiko-wt-lg'
const JWT_SECRET = 'unit-checkout-return-jwt-secret'
const ACCESS_SERVER = 'unit-checkout-return-server-token'

describe('GET /checkout/return query validation', () => {
  let app: INestApplication
  let reconcilePayment: jest.Mock

  beforeAll(async () => {
    // R17: records whether the query reached the service; DB reconciliation is tested in the e2e spec.
    reconcilePayment = jest.fn().mockResolvedValue({ status: 'completed', planSlug: 'dropi-roax' })
    const moduleRef = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        // R17: only the query DTO pipe border is under test here.
        { provide: CheckoutService, useValue: { reconcilePayment } },
        // R17: unused by GET /checkout/return; satisfies CheckoutController constructor.
        { provide: ProviderConfigService, useValue: { getAvailableProviders: jest.fn() } },
        // R17: brand membership is exercised in the suite below and in the PostgreSQL e2e spec.
        {
          provide: ClientPlatformService,
          useValue: { canViewBrandCredit: jest.fn().mockResolvedValue(true) },
        },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(() => reconcilePayment.mockClear())

  it('rejects a request without paymentId or correlation_id with 400 INVALID_REQUEST before calling the service', async () => {
    // R15 (Mutation): dropping @ValidateIf or @IsUUID on paymentId lets an empty query reach reconcilePayment.
    const res = await request(app.getHttpServer()).get('/checkout/return')

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' })
    expect(reconcilePayment).not.toHaveBeenCalled()
  })

  it.each([
    ['empty paymentId', 'paymentId='],
    ['non-UUID paymentId', 'paymentId=not-a-uuid'],
    ['empty correlation_id', 'correlation_id='],
    ['non-UUID correlation_id', 'correlation_id=not-a-uuid'],
  ])('rejects %s with 400 INVALID_REQUEST before calling the service', async (_label, query) => {
    // R15 (Mutation): dropping @IsUUID on paymentId or correlation_id lets non-UUID strings reach reconcilePayment.
    const res = await request(app.getHttpServer()).get(`/checkout/return?${query}`)

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' })
    expect(reconcilePayment).not.toHaveBeenCalled()
  })

  it.each([
    ['paymentId', `paymentId=${PAYMENT_ID}`],
    ['correlation_id', `correlation_id=${PAYMENT_ID}`],
  ])('forwards a valid UUID %s to CheckoutService.reconcilePayment', async (_label, query) => {
    // R15 (Mutation): dropping correlation_id fallback in paymentReturn breaks ConfioPagos redirect queries.
    const res = await request(app.getHttpServer()).get(`/checkout/return?${query}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { status: 'completed', planSlug: 'dropi-roax' } })
    expect(reconcilePayment).toHaveBeenCalledWith(PAYMENT_ID, expect.any(Function))
  })
})

describe('GET /checkout/return brand scope through CheckoutController and CheckoutService', () => {
  const originalFetch = global.fetch
  const envSnapshot = {
    JWT_SECRET: process.env.JWT_SECRET,
    ACCESS_SERVER: process.env.ACCESS_SERVER,
    COOKIE_SESSION: process.env.COOKIE_SESSION,
    SERVICE_PLATFORM: process.env.SERVICE_PLATFORM,
  }

  let app: INestApplication
  let jwtService: JwtService
  let findOnePayment: jest.Mock
  let getProvider: jest.Mock
  let fetchMock: jest.Mock

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET
    process.env.ACCESS_SERVER = ACCESS_SERVER
    process.env.COOKIE_SESSION = COOKIE_NAME
    process.env.SERVICE_PLATFORM = 'http://platform.test'

    // R17: unit suite must not open a real DB; PostgreSQL rows are tested in checkout-return-brand-scope.e2e-spec.ts.
    findOnePayment = jest.fn()
    // R17: external payment gateway HTTP is a third party; spy verifies it is never called for foreign brands.
    getProvider = jest.fn()
    const emptyRepo = { findOne: jest.fn(), create: jest.fn(), save: jest.fn(), update: jest.fn() }

    const moduleRef = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        ApiAuthGuard,
        JwtService,
        ClientPlatformService,
        CheckoutService,
        {
          provide: getRepositoryToken(Payment, 'DBWrite'),
          useValue: { ...emptyRepo, findOne: findOnePayment },
        },
        { provide: getRepositoryToken(PaymentAttempt, 'DBWrite'), useValue: emptyRepo },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: emptyRepo },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), useValue: emptyRepo },
        { provide: getRepositoryToken(BillingProfile, 'DBRead'), useValue: emptyRepo },
        // R17: unit suite does not open PostgreSQL transactions; real DataSource runs in the e2e spec.
        { provide: getDataSourceToken('DBWrite'), useValue: {} },
        { provide: WalletService, useValue: {} },
        { provide: InvoiceService, useValue: {} },
        { provide: SubscriptionService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        { provide: TaxService, useValue: {} },
        { provide: DianService, useValue: {} },
        { provide: ProviderFactory, useValue: { getProvider } },
        { provide: EventBusService, useValue: {} },
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
        { provide: EnterprisePricingService, useValue: {} },
        { provide: ProviderConfigService, useValue: { getAvailableProviders: jest.fn() } },
        { provide: WebhookService, useValue: { setCheckoutService: jest.fn() } },
      ],
    }).compile()

    jwtService = moduleRef.get(JwtService)
    app = moduleRef.createNestApplication()
    app.use(cookieParser(JWT_SECRET))
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    global.fetch = originalFetch
    process.env.JWT_SECRET = envSnapshot.JWT_SECRET
    process.env.ACCESS_SERVER = envSnapshot.ACCESS_SERVER
    process.env.COOKIE_SESSION = envSnapshot.COOKIE_SESSION
    process.env.SERVICE_PLATFORM = envSnapshot.SERVICE_PLATFORM
    await app?.close()
  })

  beforeEach(() => {
    findOnePayment.mockReset()
    getProvider.mockReset()
    // R17: backend-platform is a separate service; fetch double simulates its /v1/brand/rol/user response.
    fetchMock = jest.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: url.includes(BRAND_A)
          ? [{ user: { id: 'user-brand-a' }, rol: { name: 'superuser' } }]
          : [{ user: { id: 'user-brand-b' }, rol: { name: 'superuser' } }],
      }),
    }))
    global.fetch = fetchMock as unknown as typeof fetch
  })

  const getAsBrandAFromBff = (query: string) => {
    const token = jwtService.sign({ id: 'user-brand-a' }, { secret: JWT_SECRET })
    return request(app.getHttpServer())
      .get(`/checkout/return?${query}`)
      .set('Cookie', `${COOKIE_NAME}=${token}`)
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
  }

  it('answers 404 PAYMENT_NOT_FOUND without consulting the provider when the payment belongs to another brand', async () => {
    // R15 (Mutation): removing canAccessBrand in CheckoutService.reconcilePayment returns 200 and reconciles the foreign payment.
    findOnePayment.mockResolvedValue({
      id: PAYMENT_ID,
      brandId: BRAND_B,
      provider: PaymentProvider.CONFIO,
      providerPaymentId: 'confio-order-b',
      status: PaymentStatus.PENDING,
      purpose: PaymentPurpose.PLAN_PURCHASE,
      purposeId: 'dropi-roax',
    })

    const res = await getAsBrandAFromBff(`paymentId=${PAYMENT_ID}`)

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ code: 'PAYMENT_NOT_FOUND' })
    expect(getProvider).not.toHaveBeenCalled()
  })

  it('returns completed status and refundedToWallet for the owning brand when sent with both cookie and BFF server Bearer', async () => {
    // R15 (Mutation): reading Bearer before cookie or dropping refundedToWallet breaks the owning brand return response.
    findOnePayment.mockResolvedValueOnce({
      id: PAYMENT_ID,
      brandId: BRAND_A,
      provider: PaymentProvider.CONFIO,
      status: PaymentStatus.REFUNDED,
      purpose: PaymentPurpose.PLAN_PURCHASE,
      purposeId: 'dropi-roax',
    })

    const res = await getAsBrandAFromBff(`correlation_id=${PAYMENT_ID}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { status: 'failed', refundedToWallet: true } })
  })
})
