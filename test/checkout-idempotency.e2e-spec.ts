import { INestApplication } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { DataSource, Repository } from 'typeorm'

import { AuditService } from '../src/audit/audit.service'
import { BillingProfile } from '../src/billing-profile/entities/billingProfile.entity'
import { buildIdempotencyFingerprint } from '../src/checkout/checkout-idempotency'
import { CheckoutController } from '../src/checkout/checkout.controller'
import { CheckoutRequest, CheckoutService } from '../src/checkout/checkout.service'
import { ClientPlatformService } from '../src/client/client-platform.service'
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
import { EnterprisePricingService } from '../src/subscription/enterprise-pricing.service'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { TaxService } from '../src/tax/tax.service'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletService } from '../src/wallet/wallet.service'
import { WebhookService } from '../src/webhook/webhook.service'

const BRAND_ID = '91b8463b-2222-4c2a-9f1a-66a0985a10e6'
const ACCESS_SERVER = 'e2e-checkout-idem-server-token'

const buildBody = (overrides: Record<string, unknown> = {}) => ({
  brandId: BRAND_ID,
  userId: 'user-e2e-1',
  purpose: 'plan_purchase',
  provider: 'wallet',
  planSlug: 'dropi-roax',
  ...overrides,
})

describe('POST /checkout idempotency e2e (PostgreSQL)', () => {
  let app: INestApplication
  let realDataSource: DataSource
  let walletService: WalletService
  let paymentRepo: Repository<Payment>
  let walletRepo: Repository<Wallet>
  let txRepo: Repository<Transaction>
  let createCheckoutMock: jest.Mock

  const envSnapshot = {
    ACCESS_SERVER: process.env.ACCESS_SERVER,
    JWT_SECRET: process.env.JWT_SECRET,
  }

  const cleanupBrandData = async () => {
    if (!realDataSource?.isInitialized) return
    await realDataSource.query(
      'DELETE FROM subscription_events WHERE "subscriptionId" IN (SELECT id FROM subscriptions WHERE "brandId" = $1)',
      [BRAND_ID],
    )
    await realDataSource.query('DELETE FROM subscriptions WHERE "brandId" = $1', [BRAND_ID])
    await realDataSource.query(
      'DELETE FROM payment_attempts WHERE "paymentId" IN (SELECT id FROM payments WHERE "brandId" = $1)',
      [BRAND_ID],
    )
    await realDataSource.query('DELETE FROM transactions WHERE "brandId" = $1', [BRAND_ID])
    await realDataSource.query('DELETE FROM payments WHERE "brandId" = $1', [BRAND_ID])
    await realDataSource.query('DELETE FROM wallets WHERE "brandId" = $1', [BRAND_ID])
  }

  const postCheckout = (payload: Record<string, unknown>, idempotencyKey?: string) => {
    const req = request(app.getHttpServer())
      .post('/checkout')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
    if (idempotencyKey !== undefined) {
      req.set('Idempotency-Key', idempotencyKey)
    }
    return req.send(payload)
  }

  beforeAll(async () => {
    process.env.ACCESS_SERVER = ACCESS_SERVER
    process.env.JWT_SECRET = 'e2e-checkout-idem-jwt-secret'

    realDataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB,
      entities: [
        Payment,
        PaymentAttempt,
        Wallet,
        Transaction,
        Subscription,
        SubscriptionEvent,
        BillingProfile,
      ],
      synchronize: false,
    })
    await realDataSource.initialize()

    paymentRepo = realDataSource.getRepository(Payment)
    walletRepo = realDataSource.getRepository(Wallet)
    txRepo = realDataSource.getRepository(Transaction)

    const provideRepo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: realDataSource.getRepository(entity),
    })
    const provideVal = (provide: any, useValue: any) => ({ provide, useValue })

    // R17: External HTTP/Redis collaborators use deterministic doubles because this e2e suite tests backend-payments HTTP + PostgreSQL persistence in isolation from remote microservices.
    createCheckoutMock = jest.fn().mockResolvedValue({
      providerPaymentId: 'cs_e2e_ok',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_e2e_ok',
    })
    const defaultPrice = {
      id: 'p-co',
      countryCode: 'CO',
      currency: 'COP',
      price: 19900,
      isDefault: true,
    }
    const defaultTax = { taxName: 'IVA', taxRate: 0.19, isInclusive: true }
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        ApiAuthGuard,
        JwtService,
        CheckoutService,
        WalletService,
        provideVal(getDataSourceToken('DBWrite'), realDataSource),
        provideRepo(Payment),
        provideRepo(PaymentAttempt),
        provideRepo(Wallet),
        provideRepo(Wallet, 'DBRead'),
        provideRepo(Transaction),
        provideRepo(Transaction, 'DBRead'),
        provideRepo(Subscription),
        provideRepo(SubscriptionEvent),
        provideRepo(BillingProfile, 'DBRead'),
        provideVal(ClientPlatformService, {
          canViewBrandCredit: jest.fn().mockResolvedValue(true),
          resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }),
          getBrandCountry: jest.fn().mockResolvedValue('CO'),
        }),
        provideVal(ClientRolesService, {
          getPlanPrice: jest.fn().mockResolvedValue(19900),
          resolvePriceForCountry: jest.fn().mockResolvedValue({ ok: true, price: defaultPrice }),
          assignPlanToBrand: jest.fn().mockResolvedValue(true),
        }),
        provideVal(InvoiceService, {
          create: jest.fn().mockResolvedValue({ data: { id: 'inv-e2e-1', invoiceNumber: 'CK-1' } }),
        }),
        provideVal(SubscriptionService, {}),
        provideVal(AuditService, { log: jest.fn().mockResolvedValue(null) }),
        provideVal(TaxService, { getTaxForCountry: jest.fn().mockResolvedValue(defaultTax) }),
        provideVal(DianService, {
          isConfigured: jest.fn().mockReturnValue(false),
          sendInvoice: jest.fn().mockResolvedValue({ success: true }),
        }),
        provideVal(ProviderFactory, {
          getProvider: jest.fn(() => ({ createCheckout: createCheckoutMock })),
        }),
        provideVal(ProviderConfigService, {
          isProviderAvailable: jest.fn().mockResolvedValue(true),
          getAvailableProviders: jest.fn().mockResolvedValue([]),
        }),
        provideVal(EnterprisePricingService, { getForBrand: jest.fn().mockResolvedValue(null) }),
        provideVal(EventBusService, {
          publishPaymentCompleted: jest.fn(),
          notifyPaymentSuccess: jest.fn(),
          notifyInvoiceReady: jest.fn(),
        }),
        provideVal(WebhookService, { setCheckoutService: jest.fn() }),
      ],
    }).compile()

    app = moduleFixture.createNestApplication()
    await app.init()
    walletService = moduleFixture.get<WalletService>(WalletService)
  })

  beforeEach(async () => {
    jest.restoreAllMocks()
    createCheckoutMock.mockReset().mockResolvedValue({
      providerPaymentId: 'cs_e2e_ok',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_e2e_ok',
    })
    await cleanupBrandData()
  })

  afterAll(async () => {
    try {
      await cleanupBrandData()
    } finally {
      try {
        if (app) {
          await app.close()
        }
      } finally {
        if (realDataSource?.isInitialized) {
          await realDataSource.destroy()
        }
        process.env.ACCESS_SERVER = envSnapshot.ACCESS_SERVER
        process.env.JWT_SECRET = envSnapshot.JWT_SECRET
      }
    }
  })

  const createBrandWallet = async (balance = 100000): Promise<Wallet> =>
    walletRepo.save(
      walletRepo.create({
        brandId: BRAND_ID,
        userId: 'user-e2e-1',
        provider: 'internal',
        currency: 'COP',
        balance,
        status: WalletStatus.ACTIVE,
      }),
    )

  it('completes a failed wallet payment on retry with the same Idempotency-Key without a second wallet debit when the first debit committed before failing', async () => {
    // R15 (Mutation): suffixing the WalletService.debit idempotencyKey per attempt charges a second wallet transaction and turns this case red.
    const wallet = await createBrandWallet(100000)
    const originalDebit = walletService.debit.bind(walletService)
    let firstAttempt = true
    // R17: Spy wraps the real WalletService.debit so the first call commits in Postgres and then simulates a lost confirmation.
    jest.spyOn(walletService, 'debit').mockImplementation(async (...args) => {
      const res = await originalDebit(...args)
      if (firstAttempt) {
        firstAttempt = false
        throw new Error('Lost confirmation after wallet transaction committed')
      }
      return res
    })

    const payload = buildBody({ walletId: wallet.id })

    const firstRes = await postCheckout(payload, 'e2e-wallet-retry-1')
    expect(firstRes.status).toBe(500)
    const failedPayment = await paymentRepo.findOne({
      where: { brandId: BRAND_ID, idempotencyKey: 'e2e-wallet-retry-1' },
    })
    expect(failedPayment?.status).toBe(PaymentStatus.FAILED)
    expect(await txRepo.count({ where: { brandId: BRAND_ID } })).toBe(1)
    expect(Number((await walletRepo.findOneBy({ id: wallet.id }))?.balance)).toBe(80100)

    const retryRes = await postCheckout(payload, 'e2e-wallet-retry-1')
    expect(retryRes.status).toBe(201)
    expect(retryRes.body.data).toMatchObject({
      paymentId: failedPayment?.id,
      status: 'completed',
    })
    expect(retryRes.body.data.subscriptionId).toBeDefined()

    const completedPayment = await paymentRepo.findOneBy({ id: failedPayment?.id })
    expect(completedPayment?.status).toBe(PaymentStatus.COMPLETED)
    expect(await paymentRepo.count({ where: { brandId: BRAND_ID } })).toBe(1)
    expect(await txRepo.count({ where: { brandId: BRAND_ID } })).toBe(1)
    expect(Number((await walletRepo.findOneBy({ id: wallet.id }))?.balance)).toBe(80100)
  })

  it('retries a failed external payment without providerPaymentId and rejects with 409 IDEMPOTENT_PAYMENT_FAILED when providerPaymentId already exists', async () => {
    // R15 (Mutation): checking metadata.checkoutResult before status === PaymentStatus.FAILED returns 201 pending with the expired checkoutUrl and turns this case red.
    createCheckoutMock
      .mockRejectedValueOnce(new Error('Stripe connection error'))
      .mockResolvedValueOnce({
        providerPaymentId: 'cs_e2e_recovered',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_e2e_recovered',
      })

    const payload = buildBody({ provider: 'stripe' })

    const firstRes = await postCheckout(payload, 'e2e-ext-retry-1')
    expect(firstRes.status).toBe(400)

    const secondRes = await postCheckout(payload, 'e2e-ext-retry-1')
    expect(secondRes.status).toBe(201)
    expect(secondRes.body.data).toMatchObject({
      status: 'pending',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_e2e_recovered',
    })

    await paymentRepo.update(
      { id: secondRes.body.data.paymentId },
      { status: PaymentStatus.FAILED, failureReason: 'Expired after 24h' },
    )

    const thirdRes = await postCheckout(payload, 'e2e-ext-retry-1')
    expect(thirdRes.status).toBe(409)
    expect(thirdRes.body).toMatchObject({
      code: 'IDEMPOTENT_PAYMENT_FAILED',
      paymentId: secondRes.body.data.paymentId,
    })
  })

  it('responds 409 IDEMPOTENT_CHECKOUT_INCOMPLETE when a completed payment lacks metadata.checkoutResult', async () => {
    // R15 (Mutation): returning { paymentId, status: existing.status } when existing.status === PaymentStatus.COMPLETED and metadata.checkoutResult is absent responds 201 and turns this case red.
    const wallet = await createBrandWallet(100000)
    const reqPayload: CheckoutRequest = {
      brandId: BRAND_ID,
      userId: 'user-e2e-1',
      purpose: 'plan_purchase',
      provider: 'wallet',
      walletId: wallet.id,
      planSlug: 'dropi-roax',
      idempotencyKey: 'e2e-incomplete-1',
    }
    const saved = await paymentRepo.save(
      paymentRepo.create({
        brandId: BRAND_ID,
        userId: 'user-e2e-1',
        idempotencyKey: 'e2e-incomplete-1',
        walletId: wallet.id,
        provider: PaymentProvider.WALLET,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: 'dropi-roax',
        amount: 19900,
        currency: 'COP',
        status: PaymentStatus.COMPLETED,
        metadata: { idempotencyFingerprint: buildIdempotencyFingerprint(reqPayload) },
      }),
    )

    const res = await postCheckout(buildBody({ walletId: wallet.id }), 'e2e-incomplete-1')

    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({
      code: 'IDEMPOTENT_CHECKOUT_INCOMPLETE',
      paymentId: saved.id,
    })
  })

  it('responds 400 INVALID_IDEMPOTENCY_KEY for a 256-char header and ignores body.idempotencyKey when header is omitted', async () => {
    // R15 (Mutation): removing the 255-character check in normalizeIdempotencyKey or keeping conditional spread in CheckoutController turns this case red.
    const wallet = await createBrandWallet(100000)
    const payload = buildBody({
      purpose: 'service_payment',
      planSlug: undefined,
      walletId: wallet.id,
      amount: 10000,
      currency: 'COP',
    })

    const tooLongRes = await postCheckout(payload, 'z'.repeat(256))
    expect(tooLongRes.status).toBe(400)
    expect(tooLongRes.body).toMatchObject({ code: 'INVALID_IDEMPOTENCY_KEY' })
    expect(await paymentRepo.count({ where: { brandId: BRAND_ID } })).toBe(0)

    const bodyKeyIgnoredRes = await postCheckout({ ...payload, idempotencyKey: 'z'.repeat(256) })
    expect(bodyKeyIgnoredRes.status).toBe(201)
    const persisted = await paymentRepo.findOneBy({ id: bodyKeyIgnoredRes.body.data.paymentId })
    expect(persisted?.idempotencyKey).toBeNull()
  })

  it('responds 409 IDEMPOTENCY_KEY_CONFLICT when the same Idempotency-Key is sent with a different payload', async () => {
    // R15 (Mutation): skipping assertMatchingIdempotencyPayload returns 201 instead of 409 IDEMPOTENCY_KEY_CONFLICT and turns this case red.
    const wallet = await createBrandWallet(100000)
    const basePayload = buildBody({
      purpose: 'service_payment',
      planSlug: undefined,
      walletId: wallet.id,
      amount: 10000,
      currency: 'COP',
    })

    const first = await postCheckout(basePayload, 'e2e-conflict-key-1')
    expect(first.status).toBe(201)

    const conflict = await postCheckout({ ...basePayload, amount: 25000 }, 'e2e-conflict-key-1')
    expect(conflict.status).toBe(409)
    expect(conflict.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
    expect(Number((await walletRepo.findOneBy({ id: wallet.id }))?.balance)).toBe(90000)
  })
})
