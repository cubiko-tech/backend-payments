import { INestApplication } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { DataSource, Repository } from 'typeorm'

import { AuditService } from '../src/audit/audit.service'
import { BillingProfile } from '../src/billing-profile/entities/billingProfile.entity'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { CheckoutController } from '../src/checkout/checkout.controller'
import { buildIdempotencyFingerprint } from '../src/checkout/checkout-idempotency'
import { CheckoutRequest, CheckoutService } from '../src/checkout/checkout.service'
import { DianService } from '../src/dian/dian.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import * as paymentEntities from '../src/payment/entities/payment.entity'
import { PaymentAttempt } from '../src/payment/entities/paymentAttempt.entity'
import { PaymentController } from '../src/payment/payment.controller'
import { PaymentService } from '../src/payment/payment.service'
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

const { Payment, PaymentProvider, PaymentPurpose, PaymentStatus } = paymentEntities
type Payment = paymentEntities.Payment
const ACCESS_SERVER = 'e2e-checkout-idem-server-token'
const BRAND_ID = 'f1111111-2222-4333-8444-555555555555'
const DEFAULT_CHECKOUT = {
  providerPaymentId: 'cs_e2e_ok',
  checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_e2e_ok',
}
const DEFAULT_PRICE = { id: 'p', countryCode: 'CO', currency: 'COP', price: 19900, isDefault: true }
const DEFAULT_TAX = { taxName: 'IVA', taxRate: 0.19, isInclusive: true }
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
  let checkoutService: CheckoutService
  let walletService: WalletService
  let paymentRepo: Repository<Payment>
  let walletRepo: Repository<Wallet>
  let txRepo: Repository<Transaction>
  let subRepo: Repository<Subscription>
  let createCheckoutMock: jest.Mock
  let assignPlanToBrandMock: jest.Mock
  const envSnapshot = [process.env.ACCESS_SERVER, process.env.JWT_SECRET]
  const cleanupBrandData = async () => {
    if (!realDataSource?.isInitialized) return
    for (const sql of [
      'DELETE FROM subscription_events WHERE "subscriptionId" IN (SELECT id FROM subscriptions WHERE "brandId" = $1)',
      'DELETE FROM subscriptions WHERE "brandId" = $1',
      'DELETE FROM payment_attempts WHERE "paymentId" IN (SELECT id FROM payments WHERE "brandId" = $1)',
      'DELETE FROM transactions WHERE "brandId" = $1',
      'DELETE FROM payments WHERE "brandId" = $1',
      'DELETE FROM wallets WHERE "brandId" = $1',
    ]) {
      await realDataSource.query(sql, [BRAND_ID])
    }
  }

  const postCheckout = (payload: Record<string, unknown>, idempotencyKey?: string) => {
    const req = request(app.getHttpServer())
      .post('/checkout')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
    if (idempotencyKey !== undefined) req.set('Idempotency-Key', idempotencyKey)
    return req.send(payload)
  }

  beforeAll(async () => {
    process.env.ACCESS_SERVER = ACCESS_SERVER
    process.env.JWT_SECRET = 'e2e-checkout-idem-jwt-secret'
    const writeEntities = [
      Payment,
      PaymentAttempt,
      Wallet,
      Transaction,
      Subscription,
      SubscriptionEvent,
    ]
    realDataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB,
      entities: [...writeEntities, BillingProfile],
      synchronize: false,
    })
    await realDataSource.initialize()
    paymentRepo = realDataSource.getRepository(Payment)
    walletRepo = realDataSource.getRepository(Wallet)
    txRepo = realDataSource.getRepository(Transaction)
    subRepo = realDataSource.getRepository(Subscription)
    const provideRepo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: realDataSource.getRepository(entity),
    })
    const provideVal = (provide: any, useValue: any) => ({ provide, useValue })
    // R17: Remote HTTP/Redis doubles isolate backend-payments HTTP + Postgres e2e persistence.
    createCheckoutMock = jest.fn().mockResolvedValue(DEFAULT_CHECKOUT)
    assignPlanToBrandMock = jest.fn().mockResolvedValue(true)
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController, PaymentController],
      providers: [
        ApiAuthGuard,
        JwtService,
        CheckoutService,
        PaymentService,
        WalletService,
        provideVal(getDataSourceToken('DBWrite'), realDataSource),
        ...writeEntities.map((e) => provideRepo(e)),
        ...[Payment, Wallet, Transaction, BillingProfile].map((e) => provideRepo(e, 'DBRead')),
        provideVal(ClientPlatformService, {
          canViewBrandCredit: jest.fn().mockResolvedValue(true),
          resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }),
          getBrandCountry: jest.fn().mockResolvedValue('CO'),
        }),
        provideVal(ClientRolesService, {
          getPlanPrice: jest.fn().mockResolvedValue(19900),
          resolvePriceForCountry: jest.fn().mockResolvedValue({ ok: true, price: DEFAULT_PRICE }),
          assignPlanToBrand: assignPlanToBrandMock,
        }),
        provideVal(InvoiceService, {
          create: jest.fn().mockResolvedValue({ data: { id: 'inv-e2e-1', invoiceNumber: 'CK-1' } }),
        }),
        provideVal(SubscriptionService, {}),
        provideVal(AuditService, { log: jest.fn().mockResolvedValue(null) }),
        provideVal(TaxService, { getTaxForCountry: jest.fn().mockResolvedValue(DEFAULT_TAX) }),
        provideVal(DianService, { isConfigured: () => false, sendInvoice: jest.fn() }),
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
    checkoutService = moduleFixture.get<CheckoutService>(CheckoutService)
    walletService = moduleFixture.get<WalletService>(WalletService)
  })

  beforeEach(async () => {
    jest.restoreAllMocks()
    assignPlanToBrandMock.mockClear().mockResolvedValue(true)
    createCheckoutMock.mockReset().mockResolvedValue(DEFAULT_CHECKOUT)
    await cleanupBrandData()
  })

  afterAll(async () => {
    try {
      await cleanupBrandData()
    } finally {
      try {
        if (app) await app.close()
      } finally {
        if (realDataSource?.isInitialized) await realDataSource.destroy()
        ;[process.env.ACCESS_SERVER, process.env.JWT_SECRET] = envSnapshot
      }
    }
  })

  const createBrandWallet = (balance = 100000): Promise<Wallet> =>
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

  const seedPayment = (overrides: Partial<Payment>): Promise<Payment> =>
    paymentRepo.save(
      paymentRepo.create({
        brandId: BRAND_ID,
        userId: 'user-e2e-1',
        provider: PaymentProvider.WALLET,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: 'dropi-roax',
        amount: 19900,
        currency: 'COP',
        ...overrides,
      }),
    )

  it('completes a failed wallet payment on retry without a second wallet debit in Postgres', async () => {
    // R15 (Mutation): suffixing WalletService.debit idempotencyKey per attempt turns this red.
    const wallet = await createBrandWallet(100000)
    const originalDebit = walletService.debit.bind(walletService)
    let firstAttempt = true
    // R17: Spy wraps real WalletService.debit to throw once after the Postgres debit commits.
    jest.spyOn(walletService, 'debit').mockImplementation(async (...args) => {
      const res = await originalDebit(...args)
      if (firstAttempt) {
        firstAttempt = false
        throw new Error('Lost confirmation after wallet transaction committed')
      }
      return res
    })

    const payload = buildBody({ walletId: wallet.id })
    expect((await postCheckout(payload, 'e2e-wallet-retry-1')).status).toBe(500)
    const failedPayment = await paymentRepo.findOne({
      where: { brandId: BRAND_ID, idempotencyKey: 'e2e-wallet-retry-1' },
    })
    expect(failedPayment?.status).toBe(PaymentStatus.FAILED)
    expect(await txRepo.count({ where: { brandId: BRAND_ID } })).toBe(1)

    const retryRes = await postCheckout(payload, 'e2e-wallet-retry-1')
    expect(retryRes.status).toBe(201)
    expect(retryRes.body.data).toMatchObject({ paymentId: failedPayment?.id, status: 'completed' })
    expect(await paymentRepo.count({ where: { brandId: BRAND_ID } })).toBe(1)
    expect(await txRepo.count({ where: { brandId: BRAND_ID } })).toBe(1)
    expect(Number((await walletRepo.findOneBy({ id: wallet.id }))?.balance)).toBe(80100)
  })

  it('claims a failed payment once in Postgres when two concurrent retries race on status', async () => {
    // R15 (Mutation): dropping status: PaymentStatus.FAILED from claim update turns this red.
    const wallet = await createBrandWallet(100000)
    const body = buildBody({ walletId: wallet.id })
    const reqPayload = { ...body, idempotencyKey: 'e2e-concurrent-claim-1' } as CheckoutRequest
    await seedPayment({
      idempotencyKey: 'e2e-concurrent-claim-1',
      walletId: wallet.id,
      status: PaymentStatus.FAILED,
      metadata: { idempotencyFingerprint: buildIdempotencyFingerprint(reqPayload) },
    })

    let releaseReads!: () => void
    const bothReadBarrier = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    let readCount = 0
    const realFindOne = paymentRepo.findOne.bind(paymentRepo)
    // R17: Barrier ensures both requests read FAILED from Postgres before racing on UPDATE.
    jest.spyOn((checkoutService as any).inFlightCheckouts, 'get').mockReturnValue(undefined)
    jest.spyOn(paymentRepo, 'findOne').mockImplementation(async (options: any) => {
      const row = await realFindOne(options)
      if (row?.status === PaymentStatus.FAILED && readCount < 2) {
        readCount += 1
        if (readCount === 2) releaseReads()
        await bothReadBarrier
      }
      return row
    })

    const [first, second] = await Promise.all([
      postCheckout(body, 'e2e-concurrent-claim-1'),
      postCheckout(body, 'e2e-concurrent-claim-1'),
    ])

    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(assignPlanToBrandMock).toHaveBeenCalledTimes(1)
    expect(await subRepo.count({ where: { brandId: BRAND_ID } })).toBe(1)
    expect(await txRepo.count({ where: { brandId: BRAND_ID } })).toBe(1)
  })

  it('rejects 409 IDEMPOTENT_PAYMENT_FAILED on a failed row seeded without fingerprint', async () => {
    // R15 (Mutation): skipping hasStoredFingerprint in canRetryFailedIdempotentPayment turns red.
    const wallet = await createBrandWallet(100000)
    await seedPayment({
      userId: 'other-user-e2e',
      idempotencyKey: 'e2e-legacy-no-fp-1',
      walletId: wallet.id,
      amount: 0.01,
      status: PaymentStatus.FAILED,
      metadata: {},
    })

    const res = await postCheckout(buildBody({ walletId: wallet.id }), 'e2e-legacy-no-fp-1')
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ code: 'IDEMPOTENT_PAYMENT_FAILED' })
    expect(await txRepo.count({ where: { brandId: BRAND_ID } })).toBe(0)
    expect(await subRepo.count({ where: { brandId: BRAND_ID } })).toBe(0)
    expect(Number((await walletRepo.findOneBy({ id: wallet.id }))?.balance)).toBe(100000)
  })

  it('returns 404 on removed POST /payment/checkout when attempting to seed client metadata', async () => {
    // R15 (Mutation): re-exposing POST /payment/checkout turns this 404 assertion red.
    const wallet = await createBrandWallet(100000)
    const body = buildBody({ walletId: wallet.id })
    const key = 'e2e-removed-payment-checkout-1'
    const fp = buildIdempotencyFingerprint({ ...body, idempotencyKey: key } as CheckoutRequest)
    const seedRes = await request(app.getHttpServer())
      .post('/payment/checkout')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
      .send({
        ...body,
        purposeId: 'dropi-roax',
        amount: 1,
        currency: 'COP',
        idempotencyKey: key,
        metadata: { idempotencyFingerprint: fp, subtotal: 1, taxAmount: 0 },
      })
    expect(seedRes.status).toBe(404)
    expect(await paymentRepo.count({ where: { brandId: BRAND_ID } })).toBe(0)
    expect((await postCheckout(body, key)).status).toBe(201)
    expect(Number((await walletRepo.findOneBy({ id: wallet.id }))?.balance)).toBe(80100)
  })

  it('retries failed external row without providerPaymentId and rejects when present', async () => {
    // R15 (Mutation): reading metadata.checkoutResult before FAILED status turns this red.
    createCheckoutMock
      .mockRejectedValueOnce(new Error('Stripe connection error'))
      .mockResolvedValueOnce({
        providerPaymentId: 'cs_e2e_recovered',
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_e2e_recovered',
      })

    const payload = buildBody({ provider: 'stripe' })
    expect((await postCheckout(payload, 'e2e-ext-retry-1')).status).toBe(400)

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
    expect(thirdRes.body).toMatchObject({ code: 'IDEMPOTENT_PAYMENT_FAILED' })
  })

  it('responds 409 IDEMPOTENT_CHECKOUT_IN_PROGRESS, 400 on >255 key, and 409 on conflict', async () => {
    // R15 (Mutation): dropping the wallet + processing branch of the replay turns this red.
    const wallet = await createBrandWallet(100000)
    const body = buildBody({ walletId: wallet.id })
    // R17: Failing the subscription step simulates a Postgres failure after the debit commits.
    const failure = new Error('Subscription failure after debit')
    jest.spyOn(checkoutService as any, 'createOrRenewSubscription').mockRejectedValueOnce(failure)
    expect((await postCheckout(body, 'e2e-incomplete-1')).status).toBe(500)
    expect(await txRepo.count({ where: { brandId: BRAND_ID } })).toBe(1)
    expect(await subRepo.count({ where: { brandId: BRAND_ID } })).toBe(0)
    const saved = await paymentRepo.findOne({
      where: { brandId: BRAND_ID, idempotencyKey: 'e2e-incomplete-1' },
    })

    const incompleteRes = await postCheckout(body, 'e2e-incomplete-1')
    expect(incompleteRes.status).toBe(409)
    expect(incompleteRes.body).toMatchObject({
      code: 'IDEMPOTENT_CHECKOUT_IN_PROGRESS',
      paymentId: saved?.id,
    })

    const svcBody = buildBody({
      purpose: 'service_payment',
      planSlug: undefined,
      walletId: wallet.id,
      amount: 10000,
      currency: 'COP',
    })
    expect((await postCheckout(svcBody, 'z'.repeat(256))).status).toBe(400)
    expect((await postCheckout({ ...svcBody, idempotencyKey: 'z'.repeat(256) })).status).toBe(201)

    expect((await postCheckout(svcBody, 'e2e-conflict-key-1')).status).toBe(201)
    const conflict = await postCheckout({ ...svcBody, amount: 25000 }, 'e2e-conflict-key-1')
    expect(conflict.status).toBe(409)
    expect(conflict.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' })
  })
})
