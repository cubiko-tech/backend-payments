import { HttpException, HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import { DataSource, In, Repository } from 'typeorm'

import { CheckoutController } from '../src/checkout/checkout.controller'
import { CheckoutRequest, CheckoutService } from '../src/checkout/checkout.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
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
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Invoice } from '../src/invoice/entities/invoice.entity'
import { InvoiceItem } from '../src/invoice/entities/invoiceItem.entity'
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

const BRAND_ID = '72a8463b-1111-4c2a-9f1a-66a0985a10e6'
const WALLET_ID = '82a8463b-2222-4c2a-9f1a-66a0985a10e6'

const createMockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn((data) => ({ id: 'mock-id', ...data })),
  save: jest.fn((data) => Promise.resolve({ id: 'mock-id', ...data })),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
})

describe('CheckoutService external payment completion concurrency (real database)', () => {
  let realDataSource: DataSource
  let realPaymentRepo: Repository<Payment>
  let realWalletRepo: Repository<Wallet>
  let realTransactionRepo: Repository<Transaction>
  let realInvoiceRepo: Repository<Invoice>
  let realInvoiceItemRepo: Repository<InvoiceItem>
  let realService: CheckoutService
  let controller: CheckoutController
  let debitMock: jest.Mock
  let creditMock: jest.Mock
  let createInvoiceMock: jest.Mock
  const createdPaymentIds: string[] = []
  const createdWalletIds: string[] = []

  beforeAll(async () => {
    dotenvConfig({ path: '.env' })
    realDataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [Payment, BillingProfile, Wallet, Transaction, Invoice, InvoiceItem],
      synchronize: false,
      ...(process.env.SSL === 'true' ? { ssl: { rejectUnauthorized: false } } : {}),
    })
    await realDataSource.initialize()
    await Promise.all([realDataSource.query('SELECT 1'), realDataSource.query('SELECT 1')])
    realPaymentRepo = realDataSource.getRepository(Payment)
    realWalletRepo = realDataSource.getRepository(Wallet)
    realTransactionRepo = realDataSource.getRepository(Transaction)
    realInvoiceRepo = realDataSource.getRepository(Invoice)
    realInvoiceItemRepo = realDataSource.getRepository(InvoiceItem)
  })

  afterAll(async () => {
    if (realDataSource?.isInitialized) {
      if (createdPaymentIds.length > 0) {
        const invoices = await realInvoiceRepo.find({
          where: { paymentId: In(createdPaymentIds) },
        })
        if (invoices.length > 0) {
          const invoiceIds = invoices.map((inv) => inv.id)
          await realInvoiceItemRepo.delete({ invoiceId: In(invoiceIds) })
          await realInvoiceRepo.delete({ id: In(invoiceIds) })
        }
      }
      if (createdWalletIds.length > 0) {
        await realTransactionRepo.delete({ walletId: In(createdWalletIds) })
        await realWalletRepo.delete({ id: In(createdWalletIds) })
      }
      if (createdPaymentIds.length > 0) {
        await realPaymentRepo.delete({ id: In(createdPaymentIds) })
      }
      await realDataSource.destroy()
    }
  })

  beforeEach(async () => {
    debitMock = jest.fn().mockResolvedValue(null)
    creditMock = jest.fn().mockResolvedValue(null)
    createInvoiceMock = jest
      .fn()
      .mockResolvedValue({ data: { id: 'inv-real-1', invoiceNumber: 'CK-REAL-1' } })

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        CheckoutService,
        { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: realPaymentRepo },
        { provide: getRepositoryToken(PaymentAttempt, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: createMockRepo() },
        {
          provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'),
          useValue: createMockRepo(),
        },
        {
          provide: getRepositoryToken(BillingProfile, 'DBRead'),
          useValue: realDataSource.getRepository(BillingProfile),
        },
        { provide: getDataSourceToken('DBWrite'), useValue: realDataSource },
        {
          provide: WalletService,
          useValue: {
            debit: debitMock,
            credit: creditMock,
            findById: jest.fn().mockResolvedValue({
              data: { id: WALLET_ID, brandId: BRAND_ID, currency: 'COP' },
            }),
          },
        },
        {
          provide: InvoiceService,
          useValue: { create: createInvoiceMock },
        },
        { provide: SubscriptionService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(null) } },
        {
          provide: TaxService,
          useValue: {
            getTaxForCountry: jest
              .fn()
              .mockResolvedValue({ taxName: 'IVA', taxRate: 0.19, isInclusive: false }),
          },
        },
        {
          provide: DianService,
          useValue: {
            isConfigured: jest.fn().mockReturnValue(false),
            sendInvoice: jest.fn().mockResolvedValue({ success: true }),
          },
        },
        {
          provide: ProviderFactory,
          useValue: {
            getProvider: jest.fn(() => ({
              createCheckout: jest
                .fn()
                .mockResolvedValue({ providerPaymentId: 'ext-1', checkoutUrl: 'https://pay/1' }),
            })),
          },
        },
        {
          provide: EventBusService,
          useValue: {
            publishPaymentCompleted: jest.fn(),
            notifyPaymentSuccess: jest.fn(),
            notifyInvoiceReady: jest.fn(),
          },
        },
        {
          provide: ClientRolesService,
          useValue: {
            getPlanPrice: jest.fn().mockResolvedValue(777777),
            resolvePriceForCountry: jest.fn().mockResolvedValue({
              ok: true,
              price: {
                id: 'price-1',
                countryCode: 'CO',
                currency: 'COP',
                price: 19900,
                isDefault: true,
              },
            }),
            assignPlanToBrand: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: ClientPlatformService,
          useValue: {
            resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }),
            getBrandCountry: jest.fn().mockResolvedValue('CO'),
            canViewBrandCredit: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: EnterprisePricingService,
          useValue: { getForBrand: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: ProviderConfigService,
          useValue: { isProviderAvailable: jest.fn().mockResolvedValue(true) },
        },
        { provide: WebhookService, useValue: { setCheckoutService: jest.fn() } },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    realService = module.get<CheckoutService>(CheckoutService)
    controller = module.get<CheckoutController>(CheckoutController)
  })

  it('completes a pending recharge payment only once when two calls run in parallel, and ignores a subsequent call in series', async () => {
    const pendingPayment = await realPaymentRepo.save(
      realPaymentRepo.create({
        brandId: BRAND_ID,
        userId: 'u-1',
        walletId: WALLET_ID,
        provider: PaymentProvider.STRIPE,
        amount: 119000,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        purpose: PaymentPurpose.WALLET_RECHARGE,
        metadata: { country: 'CO' },
      }),
    )
    createdPaymentIds.push(pendingPayment.id)

    await Promise.all([
      realService.completeExternalPayment(pendingPayment.id, { source: 'webhook' }),
      realService.completeExternalPayment(pendingPayment.id, { source: 'reconcile' }),
    ])

    expect(creditMock).toHaveBeenCalledTimes(1)
    expect(creditMock).toHaveBeenCalledWith(
      WALLET_ID,
      100000,
      expect.objectContaining({
        brandId: BRAND_ID,
        category: 'recharge',
        referenceType: 'payment',
        referenceId: pendingPayment.id,
      }),
    )
    expect(createInvoiceMock).toHaveBeenCalledTimes(1)

    const stored = await realPaymentRepo.findOne({ where: { id: pendingPayment.id } })
    expect(stored?.status).toBe(PaymentStatus.COMPLETED)
    expect(stored?.paidAt).toBeInstanceOf(Date)

    await realService.completeExternalPayment(pendingPayment.id, { source: 'retry' })

    expect(creditMock).toHaveBeenCalledTimes(1)
    expect(createInvoiceMock).toHaveBeenCalledTimes(1)
  })

  describe('POST /checkout Idempotency-Key deduplication and unique constraint (real database)', () => {
    const postControllerCheckout = async (
      body: CheckoutRequest,
      headers: Record<string, string> = {},
    ): Promise<{ status: number; body: any }> => {
      try {
        const data = await controller.processCheckout({ ...body }, { headers })
        if (data?.data?.paymentId) {
          createdPaymentIds.push(data.data.paymentId)
        }
        return { status: HttpStatus.CREATED, body: data }
      } catch (error) {
        if (error instanceof HttpException) {
          return { status: error.getStatus(), body: error.getResponse() }
        }
        throw error
      }
    }

    it('returns 201 with the same paymentId and performs a single wallet debit on duplicate POST /checkout with the same Idempotency-Key', async () => {
      const idempotencyKey = `e2e-dup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const body: CheckoutRequest = {
        brandId: BRAND_ID,
        userId: 'u-1',
        purpose: 'service_payment',
        provider: 'wallet',
        walletId: WALLET_ID,
        amount: 10000,
        currency: 'COP',
      }

      const first = await postControllerCheckout(body, { 'Idempotency-Key': idempotencyKey })
      const second = await postControllerCheckout(body, { 'Idempotency-Key': idempotencyKey })

      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
      expect(debitMock).toHaveBeenCalledTimes(1)
      expect(second.body.data.paymentId).toBe(first.body.data.paymentId)

      const rows = await realPaymentRepo.find({
        where: { brandId: BRAND_ID, idempotencyKey },
      })
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(first.body.data.paymentId)
    })

    it('creates a single payment row and performs a single wallet debit when two POST /checkout calls with the same Idempotency-Key run simultaneously', async () => {
      const idempotencyKey = `e2e-simul-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const body: CheckoutRequest = {
        brandId: BRAND_ID,
        userId: 'u-1',
        purpose: 'service_payment',
        provider: 'wallet',
        walletId: WALLET_ID,
        amount: 15000,
        currency: 'COP',
      }

      const [first, second] = await Promise.all([
        postControllerCheckout(body, { 'Idempotency-Key': idempotencyKey }),
        postControllerCheckout(body, { 'Idempotency-Key': idempotencyKey }),
      ])

      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
      expect(debitMock).toHaveBeenCalledTimes(1)
      expect(second.body.data.paymentId).toBe(first.body.data.paymentId)

      const rows = await realPaymentRepo.find({
        where: { brandId: BRAND_ID, idempotencyKey },
      })
      expect(rows).toHaveLength(1)
      expect(rows[0].id).toBe(first.body.data.paymentId)
    })

    it('responds 409 IDEMPOTENCY_KEY_CONFLICT without creating a new payment or debit when the same Idempotency-Key is reused with a different body', async () => {
      const idempotencyKey = `e2e-conflict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      const first = await postControllerCheckout(
        {
          brandId: BRAND_ID,
          userId: 'u-1',
          purpose: 'service_payment',
          provider: 'wallet',
          walletId: WALLET_ID,
          amount: 10000,
          currency: 'COP',
        },
        { 'Idempotency-Key': idempotencyKey },
      )

      const conflict = await postControllerCheckout(
        {
          brandId: BRAND_ID,
          userId: 'u-1',
          purpose: 'service_payment',
          provider: 'wallet',
          walletId: WALLET_ID,
          amount: 30000,
          currency: 'COP',
        },
        { 'Idempotency-Key': idempotencyKey },
      )

      expect(first.status).toBe(201)
      expect(conflict.status).toBe(409)
      expect(conflict.body).toEqual(
        expect.objectContaining({
          code: 'IDEMPOTENCY_KEY_CONFLICT',
        }),
      )
      expect(debitMock).toHaveBeenCalledTimes(1)

      const rows = await realPaymentRepo.find({
        where: { brandId: BRAND_ID, idempotencyKey },
      })
      expect(rows).toHaveLength(1)
    })

    it('creates two payments and two debits as today when no Idempotency-Key header is provided', async () => {
      const body: CheckoutRequest = {
        brandId: BRAND_ID,
        userId: 'u-1',
        purpose: 'service_payment',
        provider: 'wallet',
        walletId: WALLET_ID,
        amount: 10000,
        currency: 'COP',
      }

      const first = await postControllerCheckout(body)
      const second = await postControllerCheckout(body)

      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
      expect(second.body.data.paymentId).not.toBe(first.body.data.paymentId)
      expect(debitMock).toHaveBeenCalledTimes(2)
    })
  })

  describe('External payment completion intermediate status and retry (Postgres)', () => {
    let checkoutWithRealPersistence: CheckoutService
    let failNextTransactionSaveReason: string | null = null
    let failNextInvoiceSaveReason: string | null = null

    beforeEach(async () => {
      failNextTransactionSaveReason = null
      failNextInvoiceSaveReason = null

      // R17 test double over realDataSource.createQueryRunner that delegates to Postgres
      // and injects a single transient write failure when configured by a test case.
      const wrappedDataSource = {
        createQueryRunner: () => {
          const qr = realDataSource.createQueryRunner()
          const originalSave = qr.manager.save.bind(qr.manager)
          qr.manager.save = (async (entityOrTarget: any, maybeEntities?: any) => {
            if (failNextTransactionSaveReason && entityOrTarget === Transaction) {
              const reason = failNextTransactionSaveReason
              failNextTransactionSaveReason = null
              throw new Error(reason)
            }
            if (failNextInvoiceSaveReason && entityOrTarget === Invoice) {
              const reason = failNextInvoiceSaveReason
              failNextInvoiceSaveReason = null
              throw new Error(reason)
            }
            if (maybeEntities !== undefined) {
              return originalSave(entityOrTarget, maybeEntities)
            }
            return originalSave(entityOrTarget)
          }) as typeof qr.manager.save
          return qr
        },
      } as unknown as DataSource

      const realWalletService = new WalletService(
        realWalletRepo,
        realWalletRepo,
        realTransactionRepo,
        realTransactionRepo,
        wrappedDataSource,
      )

      const realInvoiceService = new InvoiceService(
        realInvoiceRepo,
        realInvoiceRepo,
        realInvoiceItemRepo,
        wrappedDataSource,
      )

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          CheckoutService,
          { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: realPaymentRepo },
          { provide: getRepositoryToken(PaymentAttempt, 'DBWrite'), useValue: createMockRepo() },
          { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: createMockRepo() },
          {
            provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'),
            useValue: createMockRepo(),
          },
          {
            provide: getRepositoryToken(BillingProfile, 'DBRead'),
            useValue: realDataSource.getRepository(BillingProfile),
          },
          { provide: getDataSourceToken('DBWrite'), useValue: realDataSource },
          { provide: WalletService, useValue: realWalletService },
          { provide: InvoiceService, useValue: realInvoiceService },
          { provide: SubscriptionService, useValue: {} },
          { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(null) } },
          {
            provide: TaxService,
            useValue: {
              getTaxForCountry: jest
                .fn()
                .mockResolvedValue({ taxName: 'IVA', taxRate: 0.19, isInclusive: false }),
            },
          },
          {
            provide: DianService,
            useValue: {
              isConfigured: jest.fn().mockReturnValue(false),
              sendInvoice: jest.fn().mockResolvedValue({ success: true }),
            },
          },
          {
            provide: ProviderFactory,
            useValue: {
              getProvider: jest.fn(() => ({
                getPaymentStatus: jest.fn().mockResolvedValue({ status: 'completed' }),
              })),
            },
          },
          {
            provide: EventBusService,
            useValue: {
              publishPaymentCompleted: jest.fn(),
              notifyPaymentSuccess: jest.fn(),
              notifyInvoiceReady: jest.fn(),
            },
          },
          {
            provide: ClientRolesService,
            useValue: {
              getPlanPrice: jest.fn().mockResolvedValue(777777),
              resolvePriceForCountry: jest.fn(),
              assignPlanToBrand: jest.fn().mockResolvedValue(true),
            },
          },
          {
            provide: ClientPlatformService,
            useValue: {
              resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }),
              getBrandCountry: jest.fn().mockResolvedValue('CO'),
              canViewBrandCredit: jest.fn().mockResolvedValue(true),
            },
          },
          {
            provide: EnterprisePricingService,
            useValue: { getForBrand: jest.fn().mockResolvedValue(null) },
          },
          {
            provide: ProviderConfigService,
            useValue: { isProviderAvailable: jest.fn().mockResolvedValue(true) },
          },
          { provide: WebhookService, useValue: { setCheckoutService: jest.fn() } },
        ],
      }).compile()

      checkoutWithRealPersistence = module.get<CheckoutService>(CheckoutService)
    })

    const seedWalletAndPendingRecharge = async () => {
      const uniqueBrandId = `brand-loc32-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const wallet = await realWalletRepo.save(
        realWalletRepo.create({
          brandId: uniqueBrandId,
          userId: 'u-loc32',
          provider: 'internal',
          currency: 'COP',
          balance: 0,
          status: WalletStatus.ACTIVE,
        }),
      )
      createdWalletIds.push(wallet.id)

      const payment = await realPaymentRepo.save(
        realPaymentRepo.create({
          brandId: uniqueBrandId,
          userId: 'u-loc32',
          walletId: wallet.id,
          provider: PaymentProvider.CONFIO,
          providerPaymentId: `confio-${Date.now()}`,
          amount: 119000,
          currency: 'COP',
          status: PaymentStatus.PENDING,
          purpose: PaymentPurpose.WALLET_RECHARGE,
          metadata: { country: 'CO' },
        }),
      )
      createdPaymentIds.push(payment.id)

      return { wallet, payment }
    }

    it('completes a pending external recharge with completed status, one wallet credit, and one invoice (happy path)', async () => {
      const { wallet, payment } = await seedWalletAndPendingRecharge()

      await checkoutWithRealPersistence.completeExternalPayment(payment.id, {
        source: 'webhook',
      })

      const storedPayment = await realPaymentRepo.findOne({ where: { id: payment.id } })
      expect(storedPayment?.status).toBe(PaymentStatus.COMPLETED)
      expect(storedPayment?.paidAt).toBeInstanceOf(Date)

      const transactions = await realTransactionRepo.find({
        where: { walletId: wallet.id },
      })
      expect(transactions).toHaveLength(1)
      expect(Number(transactions[0].amount)).toBe(100000)
      expect(transactions[0].idempotencyKey).toBe(`payment:${payment.id}:credit`)

      const updatedWallet = await realWalletRepo.findOne({ where: { id: wallet.id } })
      expect(Number(updatedWallet?.balance)).toBe(100000)

      const invoices = await realInvoiceRepo.find({ where: { paymentId: payment.id } })
      expect(invoices).toHaveLength(1)
      expect(Number(invoices[0].subtotal)).toBe(100000)
      expect(Number(invoices[0].taxTotal)).toBe(19000)
      expect(Number(invoices[0].total)).toBe(119000)
    })

    it('keeps the payment in processing when the credit database write rejects once, and on retry credits once and transitions to completed', async () => {
      const { wallet, payment } = await seedWalletAndPendingRecharge()
      failNextTransactionSaveReason = 'Simulated transient credit DB failure'

      await expect(
        checkoutWithRealPersistence.completeExternalPayment(payment.id, { source: 'webhook' }),
      ).rejects.toThrow('Simulated transient credit DB failure')

      const afterFailure = await realPaymentRepo.findOne({ where: { id: payment.id } })
      expect(afterFailure?.status).toBe(PaymentStatus.PROCESSING)
      expect(afterFailure?.paidAt).toBeNull()

      const transactionsAfterFailure = await realTransactionRepo.find({
        where: { walletId: wallet.id },
      })
      expect(transactionsAfterFailure).toHaveLength(0)

      const invoicesAfterFailure = await realInvoiceRepo.find({
        where: { paymentId: payment.id },
      })
      expect(invoicesAfterFailure).toHaveLength(0)

      await checkoutWithRealPersistence.completeExternalPayment(payment.id, {
        source: 'reconcile',
      })

      const afterRetry = await realPaymentRepo.findOne({ where: { id: payment.id } })
      expect(afterRetry?.status).toBe(PaymentStatus.COMPLETED)
      expect(afterRetry?.paidAt).toBeInstanceOf(Date)

      const transactionsAfterRetry = await realTransactionRepo.find({
        where: { walletId: wallet.id },
      })
      expect(transactionsAfterRetry).toHaveLength(1)
      expect(Number(transactionsAfterRetry[0].amount)).toBe(100000)

      const updatedWallet = await realWalletRepo.findOne({ where: { id: wallet.id } })
      expect(Number(updatedWallet?.balance)).toBe(100000)

      const invoicesAfterRetry = await realInvoiceRepo.find({
        where: { paymentId: payment.id },
      })
      expect(invoicesAfterRetry).toHaveLength(1)
    })

    it('keeps the payment in processing when invoice creation fails once, and on retry creates a single invoice without duplicating the credit', async () => {
      const { wallet, payment } = await seedWalletAndPendingRecharge()
      failNextInvoiceSaveReason = 'Simulated transient invoice DB failure'

      await expect(
        checkoutWithRealPersistence.completeExternalPayment(payment.id, { source: 'webhook' }),
      ).rejects.toThrow('Simulated transient invoice DB failure')

      const afterFailure = await realPaymentRepo.findOne({ where: { id: payment.id } })
      expect(afterFailure?.status).toBe(PaymentStatus.PROCESSING)
      expect(afterFailure?.paidAt).toBeNull()

      const transactionsAfterFailure = await realTransactionRepo.find({
        where: { walletId: wallet.id },
      })
      expect(transactionsAfterFailure).toHaveLength(1)

      const invoicesAfterFailure = await realInvoiceRepo.find({
        where: { paymentId: payment.id },
      })
      expect(invoicesAfterFailure).toHaveLength(0)

      await checkoutWithRealPersistence.completeExternalPayment(payment.id, {
        source: 'reconcile',
      })

      const afterRetry = await realPaymentRepo.findOne({ where: { id: payment.id } })
      expect(afterRetry?.status).toBe(PaymentStatus.COMPLETED)
      expect(afterRetry?.paidAt).toBeInstanceOf(Date)

      const transactionsAfterRetry = await realTransactionRepo.find({
        where: { walletId: wallet.id },
      })
      expect(transactionsAfterRetry).toHaveLength(1)

      const updatedWallet = await realWalletRepo.findOne({ where: { id: wallet.id } })
      expect(Number(updatedWallet?.balance)).toBe(100000)

      const invoicesAfterRetry = await realInvoiceRepo.find({
        where: { paymentId: payment.id },
      })
      expect(invoicesAfterRetry).toHaveLength(1)
    })

    it('does not change the payment, credit, or invoice when a duplicate webhook arrives for an already completed payment', async () => {
      const { wallet, payment } = await seedWalletAndPendingRecharge()

      await checkoutWithRealPersistence.completeExternalPayment(payment.id, {
        source: 'webhook',
      })

      const completedBeforeDuplicate = await realPaymentRepo.findOne({
        where: { id: payment.id },
      })
      expect(completedBeforeDuplicate?.status).toBe(PaymentStatus.COMPLETED)
      const originalPaidAt = completedBeforeDuplicate?.paidAt?.getTime()

      await checkoutWithRealPersistence.completeExternalPayment(payment.id, {
        source: 'duplicate-webhook',
      })

      const completedAfterDuplicate = await realPaymentRepo.findOne({
        where: { id: payment.id },
      })
      expect(completedAfterDuplicate?.status).toBe(PaymentStatus.COMPLETED)
      expect(completedAfterDuplicate?.paidAt?.getTime()).toBe(originalPaidAt)

      const transactions = await realTransactionRepo.find({
        where: { walletId: wallet.id },
      })
      expect(transactions).toHaveLength(1)

      const updatedWallet = await realWalletRepo.findOne({ where: { id: wallet.id } })
      expect(Number(updatedWallet?.balance)).toBe(100000)

      const invoices = await realInvoiceRepo.find({ where: { paymentId: payment.id } })
      expect(invoices).toHaveLength(1)
    })
  })
})
