import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { DataSource, Repository } from 'typeorm'

import { AuditService } from '../src/audit/audit.service'
import { BillingProfile } from '../src/billing-profile/entities/billingProfile.entity'
import { CheckoutService } from '../src/checkout/checkout.service'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { DianService } from '../src/dian/dian.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import { Payment, PaymentStatus } from '../src/payment/entities/payment.entity'
import { PaymentAttempt } from '../src/payment/entities/paymentAttempt.entity'
import { ProviderConfigService } from '../src/provider/provider-config.service'
import { ProviderFactory } from '../src/provider/provider.factory'
import { EnterprisePricingService } from '../src/subscription/enterprise-pricing.service'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { TasksService } from '../src/tasks/tasks.service'
import { TaxService } from '../src/tax/tax.service'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { WalletService } from '../src/wallet/wallet.service'
import { ConfioSubscriptionWebhookService } from '../src/webhook/confio-subscription-webhook.service'
import { WebhookEvent } from '../src/webhook/entities/webhookEvent.entity'
import { WebhookService } from '../src/webhook/webhook.service'

const BRAND_ID = 'f8787878-2222-4333-8444-555555555555'
const DEFAULT_PRICE = {
  id: 'p-87',
  countryCode: 'CO',
  currency: 'COP',
  price: 19900,
  isDefault: true,
}
const DEFAULT_TAX = { taxName: 'IVA', taxRate: 0.19, isInclusive: true }

describe('Wallet payment reconciliation & expiration e2e (PostgreSQL, LOC-87)', () => {
  let moduleFixture: TestingModule
  let realDataSource: DataSource
  let checkoutService: CheckoutService
  let tasksService: TasksService
  let paymentRepo: Repository<Payment>
  let attemptRepo: Repository<PaymentAttempt>
  let walletRepo: Repository<Wallet>
  let txRepo: Repository<Transaction>
  let subRepo: Repository<Subscription>
  let subEventRepo: Repository<SubscriptionEvent>
  let assignPlanToBrandMock: jest.Mock

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

  const seedWallet = async (balance: number): Promise<Wallet> => {
    return walletRepo.save(
      walletRepo.create({
        brandId: BRAND_ID,
        userId: '11111111-2222-4333-8444-555555555555',
        provider: 'internal',
        balance,
        currency: 'COP',
        status: WalletStatus.ACTIVE,
      }),
    )
  }

  const provokePostDebitCrash = async (
    walletId: string,
    idempotencyKey: string,
  ): Promise<Payment> => {
    const origCreateOrRenew = (checkoutService as any).createOrRenewSubscription.bind(
      checkoutService,
    )
    const origSave = paymentRepo.save.bind(paymentRepo)
    // R17: Spy on createOrRenewSubscription and paymentRepo.save to simulate a process crash right after walletService.debit commits in PostgreSQL.
    const subSpy = jest
      .spyOn(checkoutService as any, 'createOrRenewSubscription')
      .mockRejectedValueOnce(new Error('Simulated crash after wallet debit commit'))
    const saveSpy = jest.spyOn(paymentRepo, 'save').mockImplementation(async (entity: any) => {
      if (entity && entity.status === PaymentStatus.COMPLETED) {
        throw new Error('Simulated process death before persisting COMPLETED')
      }
      return origSave(entity)
    })
    try {
      await expect(
        checkoutService.processCheckout({
          brandId: BRAND_ID,
          userId: 'user-loc87-1',
          provider: 'wallet',
          purpose: 'plan_purchase',
          planSlug: 'dropi-roax',
          walletId,
          idempotencyKey,
        }),
      ).rejects.toThrow('Simulated process death before persisting COMPLETED')
    } finally {
      subSpy.mockRestore()
      saveSpy.mockRestore()
      ;(checkoutService as any).createOrRenewSubscription = origCreateOrRenew
    }
    const stuck = await paymentRepo.findOne({ where: { idempotencyKey } })
    expect(stuck).toBeDefined()
    expect(stuck!.status).toBe(PaymentStatus.PENDING)
    return stuck!
  }

  const provokePreDebitCrash = async (
    walletId: string,
    idempotencyKey: string,
  ): Promise<Payment> => {
    // R17: Spy on attemptRepo.save (which executes after paymentRepo.save(PENDING) and before walletService.debit) to simulate a crash before debiting.
    const attemptSpy = jest
      .spyOn(attemptRepo, 'save')
      .mockRejectedValueOnce(new Error('Simulated crash before walletService.debit'))
    try {
      await expect(
        checkoutService.processCheckout({
          brandId: BRAND_ID,
          userId: 'user-loc87-1',
          provider: 'wallet',
          purpose: 'plan_purchase',
          planSlug: 'dropi-roax',
          walletId,
          idempotencyKey,
        }),
      ).rejects.toThrow('Simulated crash before walletService.debit')
    } finally {
      attemptSpy.mockRestore()
    }
    const stuck = await paymentRepo.findOne({ where: { idempotencyKey } })
    expect(stuck).toBeDefined()
    expect(stuck!.status).toBe(PaymentStatus.PENDING)
    return stuck!
  }

  beforeAll(async () => {
    const entities = [
      Payment,
      PaymentAttempt,
      Wallet,
      WalletBalanceSnapshot,
      Transaction,
      Subscription,
      SubscriptionEvent,
      WebhookEvent,
      BillingProfile,
    ]
    realDataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB,
      entities,
      synchronize: false,
    })
    await realDataSource.initialize()
    paymentRepo = realDataSource.getRepository(Payment)
    attemptRepo = realDataSource.getRepository(PaymentAttempt)
    walletRepo = realDataSource.getRepository(Wallet)
    txRepo = realDataSource.getRepository(Transaction)
    subRepo = realDataSource.getRepository(Subscription)
    subEventRepo = realDataSource.getRepository(SubscriptionEvent)

    const provideRepo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: realDataSource.getRepository(entity),
    })
    const provideVal = (provide: any, useValue: any) => ({ provide, useValue })

    // R17: Remote HTTP/Redis doubles isolate backend-payments PostgreSQL persistence from external microservices.
    assignPlanToBrandMock = jest.fn().mockResolvedValue(true)
    moduleFixture = await Test.createTestingModule({
      providers: [
        CheckoutService,
        WalletService,
        TasksService,
        provideVal(getDataSourceToken('DBWrite'), realDataSource),
        ...entities.map((e) => provideRepo(e, 'DBWrite')),
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
          create: jest.fn().mockResolvedValue({ data: { id: 'inv-87', invoiceNumber: 'CK-87' } }),
        }),
        provideVal(SubscriptionService, {}),
        provideVal(AuditService, { log: jest.fn().mockResolvedValue(null) }),
        provideVal(TaxService, { getTaxForCountry: jest.fn().mockResolvedValue(DEFAULT_TAX) }),
        provideVal(DianService, { isConfigured: () => false, sendInvoice: jest.fn() }),
        provideVal(ProviderFactory, { getProvider: jest.fn() }),
        provideVal(ProviderConfigService, {
          isProviderAvailable: jest.fn().mockResolvedValue(true),
          getAvailableProviders: jest.fn().mockResolvedValue([]),
        }),
        provideVal(EnterprisePricingService, { getForBrand: jest.fn().mockResolvedValue(null) }),
        provideVal(EventBusService, {
          publishPaymentCompleted: jest.fn(),
          publishSubscriptionRenewed: jest.fn(),
          publishSubscriptionExpired: jest.fn(),
          publishWalletLowBalance: jest.fn(),
          notifyPaymentSuccess: jest.fn(),
          notifyPaymentFailed: jest.fn(),
          notifyInvoiceReady: jest.fn(),
        }),
        provideVal(WebhookService, { setCheckoutService: jest.fn() }),
        provideVal(ConfioSubscriptionWebhookService, {}),
      ],
    }).compile()

    checkoutService = moduleFixture.get(CheckoutService)
    tasksService = moduleFixture.get(TasksService)
  })

  beforeEach(async () => {
    jest.clearAllMocks()
    await cleanupBrandData()
  })

  afterAll(async () => {
    await cleanupBrandData()
    await moduleFixture?.close()
    if (realDataSource?.isInitialized) await realDataSource.destroy()
  })

  it('completes a PENDING wallet payment whose debit committed before a crash, creating the subscription without a second debit', async () => {
    // R15: turns red if reconcileWalletPayment charges walletService.debit without idempotencyKey (balance drops to 60200 and debit rows become 2) or fails to complete the payment.
    const wallet = await seedWallet(100000)
    const stuckPayment = await provokePostDebitCrash(wallet.id, 'idem-loc87-crash-after-debit')

    await realDataSource.query(
      'UPDATE payments SET "createdAt" = NOW() - INTERVAL \'10 minutes\' WHERE id = $1',
      [stuckPayment.id],
    )

    await tasksService.reconcileWalletPayments()

    const refreshedPayment = await paymentRepo.findOne({ where: { id: stuckPayment.id } })
    expect(refreshedPayment!.status).toBe(PaymentStatus.COMPLETED)
    expect(refreshedPayment!.paidAt).toBeInstanceOf(Date)
    expect(refreshedPayment!.metadata?.checkoutResult).toMatchObject({
      paymentId: stuckPayment.id,
      status: 'completed',
    })

    const sub = await subRepo.findOne({ where: { brandId: BRAND_ID } })
    expect(sub).toBeDefined()
    expect(sub!.status).toBe(SubscriptionStatus.ACTIVE)
    expect(sub!.planSlug).toBe('dropi-roax')
    expect(sub!.lastPaymentId).toBe(stuckPayment.id)
    expect(assignPlanToBrandMock).toHaveBeenCalledWith(BRAND_ID, 'dropi-roax', expect.any(Date))

    const refreshedWallet = await walletRepo.findOne({ where: { id: wallet.id } })
    expect(Number(refreshedWallet!.balance)).toBe(80100)
    const debits = await txRepo.find({ where: { referenceId: stuckPayment.id } })
    expect(debits).toHaveLength(1)
    expect(debits[0].idempotencyKey).toBe(`payment:${stuckPayment.id}:debit`)
  })

  it('marks a PENDING wallet payment without a committed debit as failed without touching the wallet balance', async () => {
    // R15: turns red if reconcileWalletPayment does not transition an un-debited PENDING payment to FAILED or modifies the wallet balance.
    const wallet = await seedWallet(100000)
    const stuckPayment = await provokePreDebitCrash(wallet.id, 'idem-loc87-crash-before-debit')

    await realDataSource.query(
      'UPDATE payments SET "createdAt" = NOW() - INTERVAL \'10 minutes\' WHERE id = $1',
      [stuckPayment.id],
    )

    await tasksService.reconcileWalletPayments()

    const refreshedPayment = await paymentRepo.findOne({ where: { id: stuckPayment.id } })
    expect(refreshedPayment!.status).toBe(PaymentStatus.FAILED)

    const refreshedWallet = await walletRepo.findOne({ where: { id: wallet.id } })
    expect(Number(refreshedWallet!.balance)).toBe(100000)
    const debits = await txRepo.find({ where: { walletId: wallet.id } })
    expect(debits).toHaveLength(0)
    const sub = await subRepo.findOne({ where: { brandId: BRAND_ID } })
    expect(sub).toBeNull()
  })

  it('serializes two simultaneous sweeps against PostgreSQL on a PROCESSING wallet payment so the subscription period extends only once', async () => {
    // R15: turns red if acquireWalletReconcileLock omits pg_advisory_xact_lock / in-process locking, letting concurrent sweeps extend currentPeriodEnd twice.
    const wallet = await seedWallet(100000)
    const initialEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
    await subRepo.save(
      subRepo.create({
        brandId: BRAND_ID,
        userId: 'user-loc87-1',
        planSlug: 'dropi-roax',
        status: SubscriptionStatus.ACTIVE,
        provider: SubscriptionProvider.WALLET,
        walletId: wallet.id,
        currentPeriodStart: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: initialEnd,
        nextBillingDate: initialEnd,
        retryCount: 0,
        autoRenew: true,
      }),
    )

    const stuckPayment = await provokePostDebitCrash(wallet.id, 'idem-loc87-concurrent-sweep')
    await realDataSource.query(
      'UPDATE payments SET status = $2, "createdAt" = NOW() - INTERVAL \'10 minutes\' WHERE id = $1',
      [stuckPayment.id, PaymentStatus.PROCESSING],
    )

    await Promise.all([
      tasksService.reconcileWalletPayments(),
      tasksService.reconcileWalletPayments(),
    ])

    const sub = await subRepo.findOne({ where: { brandId: BRAND_ID } })
    const expectedEnd = new Date(initialEnd.getTime())
    expectedEnd.setDate(expectedEnd.getDate() + 30)
    expect(
      Math.abs(new Date(sub!.currentPeriodEnd).getTime() - expectedEnd.getTime()),
    ).toBeLessThan(2000)
    const events = await subEventRepo.find({ where: { paymentId: stuckPayment.id } })
    expect(events).toHaveLength(1)
  })

  it('does not mark a debited PENDING wallet payment as failed during expirePendingCheckouts and allows the sweep to complete it', async () => {
    // R15: turns red if expirePendingCheckouts updates PENDING payments with a committed debit to FAILED.
    const wallet = await seedWallet(100000)
    const debitedPayment = await provokePostDebitCrash(wallet.id, 'idem-loc87-expire-with-debit')
    const unpaidPayment = await provokePreDebitCrash(wallet.id, 'idem-loc87-expire-without-debit')

    await realDataSource.query(
      'UPDATE payments SET "createdAt" = NOW() - INTERVAL \'25 hours\' WHERE id IN ($1, $2)',
      [debitedPayment.id, unpaidPayment.id],
    )

    await tasksService.expirePendingCheckouts()

    const afterExpireDebited = await paymentRepo.findOne({ where: { id: debitedPayment.id } })
    const afterExpireUnpaid = await paymentRepo.findOne({ where: { id: unpaidPayment.id } })
    expect(afterExpireDebited!.status).toBe(PaymentStatus.PENDING)
    expect(afterExpireUnpaid!.status).toBe(PaymentStatus.FAILED)

    await tasksService.reconcileWalletPayments()

    const completedPayment = await paymentRepo.findOne({ where: { id: debitedPayment.id } })
    expect(completedPayment!.status).toBe(PaymentStatus.COMPLETED)
    const sub = await subRepo.findOne({ where: { brandId: BRAND_ID } })
    expect(sub).toBeDefined()
    expect(sub!.status).toBe(SubscriptionStatus.ACTIVE)
    const refreshedWallet = await walletRepo.findOne({ where: { id: wallet.id } })
    expect(Number(refreshedWallet!.balance)).toBe(80100)
  })
})
