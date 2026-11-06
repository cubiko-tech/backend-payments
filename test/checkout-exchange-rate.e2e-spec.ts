/**
 * A checkout whose price is charged with the day's TRM stores the rate and its date on the
 * payment, queries the source once per hour, and is rejected with 503 and no row when there is
 * no rate. No production price sets `exchangeRate` yet (LOC-136 will), so the cases force it on
 * the resolved price; the source is a local HTTP server and the payments table is real Postgres.
 */
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import { DataSource, Repository } from 'typeorm'

import { CheckoutRequest, CheckoutService } from '../src/checkout/checkout.service'
import { buildIdempotencyFingerprint } from '../src/checkout/checkout-idempotency'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { PaymentAttempt } from '../src/payment/entities/paymentAttempt.entity'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { BillingProfile } from '../src/billing-profile/entities/billingProfile.entity'
import { WalletService } from '../src/wallet/wallet.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { AuditService } from '../src/audit/audit.service'
import { TaxService } from '../src/tax/tax.service'
import { DianService } from '../src/dian/dian.service'
import { ProviderFactory } from '../src/provider/provider.factory'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { EnterprisePricingService } from '../src/subscription/enterprise-pricing.service'
import { ProviderConfigService } from '../src/provider/provider-config.service'
import { WebhookService } from '../src/webhook/webhook.service'
import { TRM_SOURCE_URL, TrmService } from '../src/trm/trm.service'
import { TrmSource, startTrmSource, trmDown } from './support/trm-source.fixture'

const BRAND_ID = '7c1e2d3f-1351-4a35-9c35-135135135135'

// Collaborators the external checkout path calls but that play no part in the rate.
const stub = (value: unknown) => ({ useValue: value })
const repoStub = () => ({
  create: jest.fn((data) => data),
  save: jest.fn((data) => Promise.resolve(data)),
})

describe('Checkout charged with the TRM (real database)', () => {
  let dataSource: DataSource
  let payments: Repository<Payment>
  let source: TrmSource
  let service: CheckoutService

  const request = (overrides: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
    brandId: BRAND_ID,
    userId: 'user-trm',
    purpose: 'service_payment',
    provider: 'stripe',
    amount: 100000,
    currency: 'COP',
    ...overrides,
  })

  // The pricing resolver is private; this view reaches it to force the precondition until LOC-136.
  type PricingResolver = { resolveAmountAndCurrency: (req: CheckoutRequest) => Promise<object> }
  const forceExchangeRate = () => {
    const resolver = service as unknown as PricingResolver
    const original = resolver.resolveAmountAndCurrency.bind(service)
    jest
      .spyOn(resolver, 'resolveAmountAndCurrency')
      .mockImplementation(async (req) => ({ ...(await original(req)), exchangeRate: 'USD_COP' }))
  }

  beforeAll(async () => {
    dotenvConfig({ path: '.env' })
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [Payment, BillingProfile],
      synchronize: false,
      ...(process.env.SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    })
    await dataSource.initialize()
    payments = dataSource.getRepository(Payment)
  })

  afterAll(async () => {
    await payments.delete({ brandId: BRAND_ID })
    await dataSource.destroy()
  })

  const buildService = async (withTrm = true) => {
    const trm = withTrm ? [TrmService, { provide: TRM_SOURCE_URL, useValue: source.url }] : []
    const module = await Test.createTestingModule({
      providers: [
        CheckoutService,
        ...trm,
        { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: payments },
        { provide: getRepositoryToken(PaymentAttempt, 'DBWrite'), ...stub(repoStub()) },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), ...stub(repoStub()) },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), ...stub(repoStub()) },
        {
          provide: getRepositoryToken(BillingProfile, 'DBRead'),
          useValue: dataSource.getRepository(BillingProfile),
        },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        { provide: WalletService, ...stub({}) },
        { provide: InvoiceService, ...stub({}) },
        { provide: SubscriptionService, ...stub({}) },
        // Called on the external path; the rate does not depend on it.
        { provide: AuditService, ...stub({ log: jest.fn() }) },
        // A fixed 19% tax: the case looks at the rate, not at the tax.
        {
          provide: TaxService,
          ...stub({
            getTaxForCountry: jest.fn().mockResolvedValue({ taxName: 'IVA', taxRate: 0.19 }),
          }),
        },
        { provide: DianService, ...stub({}) },
        // The external provider has a cost; it answers with a checkout and no provider id.
        {
          provide: ProviderFactory,
          ...stub({
            getProvider: () => ({
              createCheckout: jest
                .fn()
                .mockResolvedValue({ providerPaymentId: null, checkoutUrl: 'https://pay/trm' }),
            }),
          }),
        },
        { provide: EventBusService, ...stub({}) },
        { provide: ClientRolesService, ...stub({}) },
        { provide: ClientPlatformService, ...stub({}) },
        { provide: EnterprisePricingService, ...stub({}) },
        // Every provider enabled: the gate by country is not what these cases test.
        {
          provide: ProviderConfigService,
          ...stub({ isProviderAvailable: jest.fn().mockResolvedValue(true) }),
        },
        // Only the late registration of onModuleInit touches the webhook service.
        { provide: WebhookService, ...stub({ setCheckoutService: jest.fn() }) },
      ],
    }).compile()
    return module.get(CheckoutService)
  }

  beforeEach(async () => {
    await payments.delete({ brandId: BRAND_ID })
    source = await startTrmSource()
    service = await buildService()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await source.close()
  })

  it('stores the rate and its date on the payment that uses it', async () => {
    // Mutation: drop the exchangeRate spread in processCheckout and the row reads null.
    forceExchangeRate()
    const { paymentId } = await service.processCheckout(request())
    const row = await payments.findOneByOrFail({ id: paymentId })
    expect(row.exchangeRate).toBe('4000.00')
    expect(row.exchangeRateDate).toBe('2026-11-06')
  })

  it('queries the source once for two payments in the same hour', async () => {
    // Mutation: skip the fresh-cache check in TrmService.getUsdCopRate and hits becomes 2.
    forceExchangeRate()
    await service.processCheckout(request())
    await service.processCheckout(request())
    expect(source.hits).toBe(1)
  })

  it('rejects with 503 and saves no payment when the source is down and nothing is cached', async () => {
    // Mutation: quote the rate after paymentRepo.save and one row is left behind.
    forceExchangeRate()
    source.reply = trmDown
    await expect(service.processCheckout(request())).rejects.toMatchObject({
      status: 503,
      code: 'EXCHANGE_RATE_UNAVAILABLE',
    })
    expect(await payments.countBy({ brandId: BRAND_ID })).toBe(0)
  })

  it('rejects with 503 and saves no payment when TrmService is not provided', async () => {
    // Mutation: return undefined from quoteUsdCopRate without TrmService and a row is saved.
    service = await buildService(false)
    forceExchangeRate()
    await expect(service.processCheckout(request())).rejects.toMatchObject({
      status: 503,
      code: 'EXCHANGE_RATE_UNAVAILABLE',
    })
    expect(await payments.countBy({ brandId: BRAND_ID })).toBe(0)
  })

  it('does not query the source for a price without exchangeRate', async () => {
    // Mutation: quote the rate on every checkout in processCheckout and hits becomes 1.
    const { paymentId } = await service.processCheckout(request())
    const row = await payments.findOneByOrFail({ id: paymentId })
    expect(source.hits).toBe(0)
    expect(row.exchangeRate).toBeNull()
    expect(row.exchangeRateDate).toBeNull()
  })

  it('keeps the stored rate when a failed payment is retried with the same key', async () => {
    // Mutation: quote the rate again in retryFailedIdempotentPayment and the row reads 4000.00.
    forceExchangeRate()
    const req = request({ idempotencyKey: 'trm-retry-1' })
    const failed = await payments.save(
      payments.create({
        brandId: BRAND_ID,
        userId: req.userId,
        idempotencyKey: req.idempotencyKey,
        provider: PaymentProvider.STRIPE,
        amount: 100000,
        currency: 'COP',
        exchangeRate: 3999.5,
        exchangeRateDate: '2026-11-05',
        status: PaymentStatus.FAILED,
        purpose: PaymentPurpose.SERVICE_PAYMENT,
        metadata: { country: 'CO', idempotencyFingerprint: buildIdempotencyFingerprint(req) },
      }),
    )
    await service.processCheckout(req)
    const row = await payments.findOneByOrFail({ id: failed.id })
    expect(row.status).toBe(PaymentStatus.PENDING)
    expect(row.exchangeRate).toBe('3999.50')
    expect(row.exchangeRateDate).toBe('2026-11-05')
    expect(source.hits).toBe(0)
  })
})
