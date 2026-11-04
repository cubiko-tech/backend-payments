import { INestApplication } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { DataSource, Repository } from 'typeorm'

import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { BillingProfile } from '../src/billing-profile/entities/billingProfile.entity'
import { CheckoutController } from '../src/checkout/checkout.controller'
import { CheckoutService } from '../src/checkout/checkout.service'
import {
  BRAND_LOOKUP_UNAVAILABLE,
  ClientPlatformService,
} from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { DianService } from '../src/dian/dian.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { PaymentAttempt } from '../src/payment/entities/paymentAttempt.entity'
import { ProviderConfigService } from '../src/provider/provider-config.service'
import { ProviderFactory } from '../src/provider/provider.factory'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { EnterprisePricingService } from '../src/subscription/enterprise-pricing.service'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { TaxService } from '../src/tax/tax.service'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { WalletService } from '../src/wallet/wallet.service'
import { WebhookService } from '../src/webhook/webhook.service'

const BRAND_A = 'a1160001-1111-4111-8111-111111111111'
const BRAND_B = 'b1160002-2222-4222-8222-222222222222'
const MISSING_PAYMENT_ID = 'c1160003-3333-4333-8333-333333333333'
const [USER_A, USER_B] = ['user-owner-brand-a', 'user-owner-brand-b']
const [COOKIE_NAME, JWT_SECRET, ACCESS_SERVER] = [
  'cubiko-wt-lg',
  'e2e-loc116-jwt-secret',
  'e2e-loc116-server-token',
]
const [PLAN_SLUG, PLAN_PRICE] = ['dropi-roax', 19900]

describe('GET /checkout/return brand scope and query validation (PostgreSQL, LOC-116)', () => {
  const originalFetch = global.fetch
  const envSnapshot = { ...process.env }

  let app: INestApplication
  let dataSource: DataSource
  let jwtService: JwtService
  let platformClient: ClientPlatformService
  let paymentRepo: Repository<Payment>
  let subRepo: Repository<Subscription>
  let subEventRepo: Repository<SubscriptionEvent>
  let txRepo: Repository<Transaction>
  let [getPaymentStatusMock, assignPlanMock, fetchMock]: jest.Mock[] = []

  const cleanBrands = async () => {
    if (!dataSource?.isInitialized) return
    for (const brandId of [BRAND_A, BRAND_B]) {
      for (const sql of [
        'DELETE FROM subscription_events WHERE "subscriptionId" IN (SELECT id FROM subscriptions WHERE "brandId" = $1)',
        'DELETE FROM subscriptions WHERE "brandId" = $1',
        'DELETE FROM payment_attempts WHERE "paymentId" IN (SELECT id FROM payments WHERE "brandId" = $1)',
        'DELETE FROM transactions WHERE "brandId" = $1',
        'DELETE FROM payments WHERE "brandId" = $1',
        'DELETE FROM wallets WHERE "brandId" = $1',
      ])
        await dataSource.query(sql, [brandId])
    }
  }

  beforeAll(async () => {
    Object.assign(process.env, {
      JWT_SECRET,
      ACCESS_SERVER,
      COOKIE_SESSION: COOKIE_NAME,
      SERVICE_PLATFORM: 'http://platform.loc116.test',
    })
    const entities = [
      Payment,
      PaymentAttempt,
      Wallet,
      WalletBalanceSnapshot,
      Transaction,
      Subscription,
      SubscriptionEvent,
      BillingProfile,
      AuditLog,
    ]
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB,
      entities,
      synchronize: false,
    })
    await dataSource.initialize()
    paymentRepo = dataSource.getRepository(Payment)
    subRepo = dataSource.getRepository(Subscription)
    subEventRepo = dataSource.getRepository(SubscriptionEvent)
    txRepo = dataSource.getRepository(Transaction)

    const provideRepo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })
    const provideVal = (provide: any, useValue: any) => ({ provide, useValue })
    // R17: External payment gateway HTTP is a third party; spy controls provider status answers.
    getPaymentStatusMock = jest.fn().mockResolvedValue({
      status: 'completed',
      metadata: { data: { status: 'Pagado', amountCents: PLAN_PRICE * 100 } },
    })
    // R17: backend-roles is a separate service; spy records plan activation calls.
    assignPlanMock = jest.fn().mockResolvedValue(true)
    const defaultPrice = { countryCode: 'CO', currency: 'COP', price: PLAN_PRICE, isDefault: true }
    const defaultTax = { taxName: 'IVA', taxRate: 0.19, isInclusive: true }

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        ApiAuthGuard,
        JwtService,
        ClientPlatformService,
        CheckoutService,
        WalletService,
        AuditService,
        provideVal(getDataSourceToken('DBWrite'), dataSource),
        ...entities.map((e) => provideRepo(e, 'DBWrite')),
        ...[Payment, Wallet, Transaction, BillingProfile, AuditLog].map((e) =>
          provideRepo(e, 'DBRead'),
        ),
        // R17: backend-roles is a separate service; double serves plan prices and records activation.
        provideVal(ClientRolesService, {
          getPlanPrice: async () => PLAN_PRICE,
          resolvePriceForCountry: async () => ({ ok: true, price: defaultPrice }),
          assignPlanToBrand: assignPlanMock,
        }),
        provideVal(InvoiceService, {
          create: async () => ({ data: { id: 'inv-1', invoiceNumber: 'CK-1' } }),
          findInvoiceOfPayment: async () => null,
        }),
        provideVal(SubscriptionService, {}),
        provideVal(TaxService, { getTaxForCountry: async () => defaultTax }),
        provideVal(DianService, { isConfigured: () => false, sendInvoice: async () => undefined }),
        // R17: ProviderFactory returns the gateway double whose getPaymentStatus we inspect.
        provideVal(ProviderFactory, {
          getProvider: () => ({ getPaymentStatus: getPaymentStatusMock }),
        }),
        provideVal(ProviderConfigService, {
          isProviderAvailable: async () => true,
          getAvailableProviders: async () => [],
        }),
        provideVal(EnterprisePricingService, { getForBrand: async () => null }),
        provideVal(EventBusService, {
          publishPaymentCompleted: async () => undefined,
          notifyPaymentSuccess: async () => undefined,
          notifyInvoiceReady: async () => undefined,
        }),
        provideVal(WebhookService, { setCheckoutService: () => undefined }),
      ],
    }).compile()

    jwtService = moduleFixture.get(JwtService)
    platformClient = moduleFixture.get(ClientPlatformService)
    app = moduleFixture.createNestApplication()
    app.use(cookieParser(JWT_SECRET))
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await cleanBrands()
    global.fetch = originalFetch
    Object.assign(process.env, {
      JWT_SECRET: envSnapshot.JWT_SECRET,
      ACCESS_SERVER: envSnapshot.ACCESS_SERVER,
      COOKIE_SESSION: envSnapshot.COOKIE_SESSION,
      SERVICE_PLATFORM: envSnapshot.SERVICE_PLATFORM,
    })
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
  })

  beforeEach(async () => {
    await cleanBrands()
    platformClient.invalidateCountryCache()
    getPaymentStatusMock.mockClear()
    assignPlanMock.mockClear()
    const reply = (data: any[]) => ({ ok: true, status: 200, json: async () => ({ data }) })
    // R17: backend-platform is a remote microservice; fetch double serves brand membership rows.
    fetchMock = jest.fn().mockImplementation(async (url: string) => {
      if (url.includes(`brand.id=${BRAND_A}`))
        return reply([{ user: { id: USER_A }, rol: { name: 'superuser' } }])
      if (url.includes(`brand.id=${BRAND_B}`))
        return reply([{ user: { id: USER_B }, rol: { name: 'superuser' } }])
      return reply([])
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  const seedPayment = (brandId: string, overrides: Partial<Payment> = {}) =>
    paymentRepo.save(
      paymentRepo.create({
        brandId,
        userId: brandId === BRAND_A ? USER_A : USER_B,
        provider: PaymentProvider.CONFIO,
        providerPaymentId: `confio-${brandId.slice(0, 8)}`,
        amount: PLAN_PRICE,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: PLAN_SLUG,
        metadata: { country: 'CO', taxRate: 0.19, taxName: 'IVA' },
        ...overrides,
      }),
    )

  /** Mirrors `frontend-platform/src/lib/bff/client.js:42-48`: user cookie + BFF server Bearer. */
  const getReturnAsUser = (userId: string, query: string) => {
    const token = jwtService.sign({ id: userId }, { secret: JWT_SECRET })
    return request(app.getHttpServer())
      .get(`/checkout/return${query ? `?${query}` : ''}`)
      .set('Cookie', `${COOKIE_NAME}=${token}`)
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
  }

  it('E1 answers 404 PAYMENT_NOT_FOUND for another brand pending payment and never reconciles it', async () => {
    // R15 (Mutation): removing canAccessBrand in reconcilePayment returns 200 and reconciles Brand B's payment.
    const payA = await seedPayment(BRAND_A)
    const payB = await seedPayment(BRAND_B)

    const res = await getReturnAsUser(USER_A, `paymentId=${payB.id}`)

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ code: 'PAYMENT_NOT_FOUND', message: 'Pago no encontrado' })
    expect(getPaymentStatusMock).not.toHaveBeenCalled()
    expect(assignPlanMock).not.toHaveBeenCalled()
    expect((await paymentRepo.findOneBy({ id: payB.id }))!.status).toBe(PaymentStatus.PENDING)
    expect((await paymentRepo.findOneBy({ id: payA.id }))!.status).toBe(PaymentStatus.PENDING)
    expect(await subRepo.findOneBy({ brandId: BRAND_B })).toBeNull()
    expect(await txRepo.findBy({ brandId: BRAND_B })).toHaveLength(0)
  })

  it('E2 answers 404 PAYMENT_NOT_FOUND when querying another brand completed payment without leaking status or planSlug', async () => {
    // R15 (Mutation): checking brand after status branches leaks the foreign payment completed status (200).
    const completedB = await seedPayment(BRAND_B, { status: PaymentStatus.COMPLETED })

    const res = await getReturnAsUser(USER_A, `paymentId=${completedB.id}`)

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ code: 'PAYMENT_NOT_FOUND' })
    expect(res.body.data).toBeUndefined()
  })

  it.each([
    ['missing query', ''],
    ['empty paymentId', 'paymentId='],
    ['non-UUID paymentId', 'paymentId=not-a-uuid'],
    ['non-UUID correlation_id', 'correlation_id=not-a-uuid'],
  ])(
    'E3 rejects %s with 400 INVALID_REQUEST and leaves seeded payments untouched',
    async (_label, query) => {
      // R15 (Mutation): removing @IsUUID from CheckoutReturnQueryDto lets invalid/missing ids reach reconcilePayment.
      const seeded = await seedPayment(BRAND_A)

      const res = await getReturnAsUser(USER_A, query)

      expect(res.status).toBe(400)
      expect(res.body).toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' })
      expect(getPaymentStatusMock).not.toHaveBeenCalled()
      expect((await paymentRepo.findOneBy({ id: seeded.id }))!.status).toBe(PaymentStatus.PENDING)
    },
  )

  it('E4 answers 404 PAYMENT_NOT_FOUND for a nonexistent UUID paymentId', async () => {
    // R15 (Mutation): dropping the !payment guard in reconcilePayment fails with 500 instead of 404 PAYMENT_NOT_FOUND.
    const res = await getReturnAsUser(USER_A, `paymentId=${MISSING_PAYMENT_ID}`)

    expect(res.status).toBe(404)
    expect(res.body).toMatchObject({ code: 'PAYMENT_NOT_FOUND', message: 'Pago no encontrado' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('E5 reconciles the owning brand pending payment and returns 200 completed with planSlug for both paymentId and correlation_id', async () => {
    // R15 (Mutation): reading the BFF server Bearer before the session cookie turns userId into '' and returns 404.
    const payA1 = await seedPayment(BRAND_A)
    const payA2 = await seedPayment(BRAND_A, { providerPaymentId: 'confio-a-2' })

    const res1 = await getReturnAsUser(USER_A, `paymentId=${payA1.id}`)
    const res2 = await getReturnAsUser(USER_A, `correlation_id=${payA2.id}`)

    expect(res1.status).toBe(200)
    expect(res1.body).toEqual({ data: { status: 'completed', planSlug: PLAN_SLUG } })
    expect(res2.status).toBe(200)
    expect(res2.body).toEqual({ data: { status: 'completed', planSlug: PLAN_SLUG } })
    expect((await paymentRepo.findOneBy({ id: payA1.id }))!.status).toBe(PaymentStatus.COMPLETED)
    expect((await paymentRepo.findOneBy({ id: payA2.id }))!.status).toBe(PaymentStatus.COMPLETED)
    expect((await subRepo.findOneBy({ brandId: BRAND_A }))!.planSlug).toBe(PLAN_SLUG)
  })

  it('E6 returns status failed with refundedToWallet true for the owning brand when an external payment was refunded to the wallet', async () => {
    // R15 (Mutation): dropping the refunded branch in reconcilePayment omits refundedToWallet: true for the owner.
    const refundedA = await seedPayment(BRAND_A, { status: PaymentStatus.REFUNDED })

    const res = await getReturnAsUser(USER_A, `paymentId=${refundedA.id}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { status: 'failed', refundedToWallet: true } })
  })

  it('E7 answers 503 BRAND_LOOKUP_UNAVAILABLE fail-closed without reconciling when backend-platform is down', async () => {
    // R15 (Mutation): swallowing platform errors or skipping canAccessBrand reconciles instead of failing with 503.
    const payA = await seedPayment(BRAND_A)
    platformClient.invalidateCountryCache()
    expect((platformClient as any).countryCache.size).toBe(0)
    // R17: shuts down the entire HTTP transport to backend-platform to simulate an outage.
    global.fetch = jest
      .fn()
      .mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:3010'),
      ) as unknown as typeof fetch

    const res = await getReturnAsUser(USER_A, `paymentId=${payA.id}`)

    expect(res.status).toBe(503)
    expect(res.body).toMatchObject({ code: BRAND_LOOKUP_UNAVAILABLE })
    expect((platformClient as any).countryCache.size).toBe(0)
    expect(getPaymentStatusMock).not.toHaveBeenCalled()
    expect((await paymentRepo.findOneBy({ id: payA.id }))!.status).toBe(PaymentStatus.PENDING)
  })

  it('E8 handles concurrent return requests: rejects foreign retries with 404 and applies the owning brand purchase only once', async () => {
    // R15 (Mutation): removing canAccessBrand or the atomic status claim lets foreign or duplicate calls apply.
    const payA = await seedPayment(BRAND_A)
    const payB = await seedPayment(BRAND_B)

    const [foreign1, foreign2] = await Promise.all([
      getReturnAsUser(USER_A, `paymentId=${payB.id}`),
      getReturnAsUser(USER_A, `paymentId=${payB.id}`),
    ])
    expect(foreign1.status).toBe(404)
    expect(foreign2.status).toBe(404)
    expect((await paymentRepo.findOneBy({ id: payB.id }))!.status).toBe(PaymentStatus.PENDING)

    const [owner1, owner2] = await Promise.all([
      getReturnAsUser(USER_A, `paymentId=${payA.id}`),
      getReturnAsUser(USER_A, `paymentId=${payA.id}`),
    ])
    expect(owner1.status).toBe(200)
    expect(owner2.status).toBe(200)
    expect(owner1.body).toEqual({ data: { status: 'completed', planSlug: PLAN_SLUG } })
    expect(owner2.body).toEqual({ data: { status: 'completed', planSlug: PLAN_SLUG } })
    expect(assignPlanMock).toHaveBeenCalledTimes(1)
    const sub = (await subRepo.findOneBy({ brandId: BRAND_A }))!
    expect(await subEventRepo.findBy({ subscriptionId: sub.id })).toHaveLength(1)
  })

  it('E9 rejects a foreign caller with 404 when the payment is in intermediate processing state and lets the owner finish it once', async () => {
    // R15 (Mutation): skipping canAccessBrand on processing rows lets a foreign caller run completeExternalPayment.
    const processingB = await seedPayment(BRAND_B, {
      status: PaymentStatus.PROCESSING,
      providerPaymentId: null as unknown as string,
    })
    const processingA = await seedPayment(BRAND_A, {
      status: PaymentStatus.PROCESSING,
      providerPaymentId: null as unknown as string,
    })

    const foreignRes = await getReturnAsUser(USER_A, `paymentId=${processingB.id}`)
    expect(foreignRes.status).toBe(404)
    expect((await paymentRepo.findOneBy({ id: processingB.id }))!.status).toBe(
      PaymentStatus.PROCESSING,
    )

    const ownerRes = await getReturnAsUser(USER_A, `paymentId=${processingA.id}`)
    expect(ownerRes.status).toBe(200)
    expect(ownerRes.body).toEqual({ data: { status: 'completed', planSlug: PLAN_SLUG } })
    expect((await paymentRepo.findOneBy({ id: processingA.id }))!.status).toBe(
      PaymentStatus.COMPLETED,
    )
  })
})
