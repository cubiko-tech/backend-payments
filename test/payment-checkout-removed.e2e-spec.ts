import { existsSync } from 'fs'
import { join } from 'path'
import { INestApplication, InjectionToken } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { DataSource, EntityTarget, ObjectLiteral, Repository } from 'typeorm'

import { AuditService } from '../src/audit/audit.service'
import { BillingProfile } from '../src/billing-profile/entities/billingProfile.entity'
import { CheckoutController } from '../src/checkout/checkout.controller'
import { CheckoutService } from '../src/checkout/checkout.service'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { DianService } from '../src/dian/dian.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import { Payment, PaymentStatus } from '../src/payment/entities/payment.entity'
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

const ACCESS_SERVER = 'e2e-payment-checkout-removed-token'
const BRAND_ID = 'f9393939-2222-4333-8444-555555555555'

describe('POST /payment/checkout removal e2e (PostgreSQL, LOC-93)', () => {
  let app: INestApplication
  let realDataSource: DataSource
  let paymentRepo: Repository<Payment>
  let walletRepo: Repository<Wallet>
  const envSnapshot = {
    ACCESS_SERVER: process.env.ACCESS_SERVER,
    JWT_SECRET: process.env.JWT_SECRET,
  }

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

  beforeAll(async () => {
    process.env.ACCESS_SERVER = ACCESS_SERVER
    process.env.JWT_SECRET = 'e2e-payment-checkout-removed-jwt'
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

    const provideRepo = (entity: EntityTarget<ObjectLiteral>, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity as Parameters<typeof getRepositoryToken>[0], conn),
      useValue: realDataSource.getRepository(entity),
    })
    const provideVal = (provide: InjectionToken, useValue: unknown) => ({ provide, useValue })
    const defaultPrice = {
      id: 'p-co',
      countryCode: 'CO',
      currency: 'COP',
      price: 19900,
      isDefault: true,
    }
    const defaultTax = { taxName: 'IVA', taxRate: 0.19, isInclusive: true }
    // R17: Remote HTTP/Redis doubles isolate backend-payments HTTP + Postgres e2e persistence.
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController, CheckoutController],
      providers: [
        ApiAuthGuard,
        JwtService,
        PaymentService,
        CheckoutService,
        WalletService,
        provideVal(getDataSourceToken('DBWrite'), realDataSource),
        ...[Payment, PaymentAttempt, Wallet, Transaction, Subscription, SubscriptionEvent].map(
          (e) => provideRepo(e),
        ),
        ...[Payment, Wallet, Transaction, BillingProfile].map((e) => provideRepo(e, 'DBRead')),
        provideVal(ClientPlatformService, {
          canViewBrandCredit: jest.fn().mockResolvedValue(true),
          resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }),
          getBrandCountry: jest.fn().mockResolvedValue('CO'),
        }),
        // R17: Outbound roles/invoice/audit/tax/dian/event/provider doubles isolate Postgres e2e.
        provideVal(ClientRolesService, {
          getPlanPrice: jest.fn().mockResolvedValue(19900),
          resolvePriceForCountry: jest.fn().mockResolvedValue({ ok: true, price: defaultPrice }),
          assignPlanToBrand: jest.fn().mockResolvedValue(true),
        }),
        provideVal(InvoiceService, {
          create: jest
            .fn()
            .mockResolvedValue({ data: { id: 'inv-e2e-93', invoiceNumber: 'CK-93' } }),
        }),
        provideVal(SubscriptionService, {}),
        provideVal(AuditService, { log: jest.fn().mockResolvedValue(null) }),
        provideVal(TaxService, {
          calculateFromTotal: jest
            .fn()
            .mockImplementation((_c: string, total: number) =>
              Promise.resolve({ subtotal: total, taxAmount: 0, total, ...defaultTax }),
            ),
          getTaxForCountry: jest.fn().mockResolvedValue(defaultTax),
        }),
        // R17: External DIAN, EventBus, ProviderFactory, ProviderConfig, Webhook, EnterprisePricing doubles.
        provideVal(DianService, {
          isConfigured: jest.fn().mockReturnValue(false),
          sendInvoice: jest.fn().mockResolvedValue({ success: true }),
        }),
        provideVal(EventBusService, {
          publishPaymentCompleted: jest.fn(),
          notifyPaymentSuccess: jest.fn(),
          emitPaymentCompleted: jest.fn().mockResolvedValue('evt-1'),
          emitPaymentFailed: jest.fn().mockResolvedValue('evt-2'),
          emitInvoiceCreated: jest.fn().mockResolvedValue('evt-3'),
          emitWalletDebited: jest.fn().mockResolvedValue('evt-4'),
          emitWalletCredited: jest.fn().mockResolvedValue('evt-5'),
        }),
        provideVal(ProviderFactory, {
          getProvider: jest.fn(() => ({
            // R17: Provider createCheckout stub avoids live Stripe network calls.
            createCheckout: jest.fn(),
          })),
        }),
        provideVal(ProviderConfigService, {
          getActiveProvider: jest.fn().mockResolvedValue('stripe'),
          getAvailableProviders: jest.fn().mockResolvedValue(['stripe', 'wallet']),
        }),
        provideVal(WebhookService, {
          setCheckoutService: jest.fn(),
          registerSubscriptionService: jest.fn(),
        }),
        provideVal(EnterprisePricingService, {
          getCustomPrice: jest.fn().mockResolvedValue(null),
        }),
      ],
    }).compile()

    app = moduleFixture.createNestApplication()
    await app.init()
  })

  beforeEach(async () => {
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
        process.env.ACCESS_SERVER = envSnapshot.ACCESS_SERVER
        process.env.JWT_SECRET = envSnapshot.JWT_SECRET
      }
    }
  })

  it('responds 404 on POST /payment/checkout and inserts no payment row in Postgres', async () => {
    // R15 (Mutation): restoring @Post('checkout') createCheckout in PaymentController returns 201 and turns this red.
    const res = await request(app.getHttpServer())
      .post('/payment/checkout')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
      .send({
        brandId: BRAND_ID,
        userId: 'user-e2e-93',
        provider: 'wallet',
        amount: 1,
        currency: 'COP',
        purpose: 'plan_purchase',
        purposeId: 'dropi-roax',
        idempotencyKey: 'spoofed-e2e-key',
        metadata: { idempotencyFingerprint: 'spoofed-e2e-fp' },
      })

    expect(res.status).toBe(404)
    expect(await paymentRepo.count({ where: { brandId: BRAND_ID } })).toBe(0)
    expect(Reflect.get(PaymentController.prototype, 'createCheckout')).toBeUndefined()
    expect(Reflect.get(PaymentService.prototype, 'createCheckout')).toBeUndefined()
    expect(
      existsSync(join(__dirname, '..', 'src', 'payment', 'dto', 'create-payment-checkout.dto.ts')),
    ).toBe(false)
  })

  it('completes POST /checkout in Postgres without changes', async () => {
    // R15 (Mutation): removing @Post() processCheckout in CheckoutController returns 404 and turns this red.
    const wallet = await walletRepo.save(
      walletRepo.create({
        brandId: BRAND_ID,
        userId: 'user-e2e-93',
        provider: 'internal',
        currency: 'COP',
        balance: 100000,
        status: WalletStatus.ACTIVE,
      }),
    )

    const res = await request(app.getHttpServer())
      .post('/checkout')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
      .set('Idempotency-Key', 'e2e-loc93-checkout-1')
      .send({
        brandId: BRAND_ID,
        userId: 'user-e2e-93',
        purpose: 'plan_purchase',
        provider: 'wallet',
        walletId: wallet.id,
        planSlug: 'dropi-roax',
      })

    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ status: 'completed' })
    const saved = await paymentRepo.findOne({
      where: { brandId: BRAND_ID, idempotencyKey: 'e2e-loc93-checkout-1' },
    })
    expect(saved?.status).toBe(PaymentStatus.COMPLETED)
    expect(Number(saved?.amount)).toBe(19900)
    expect(Number((await walletRepo.findOneBy({ id: wallet.id }))?.balance)).toBe(80100)
  })
})
