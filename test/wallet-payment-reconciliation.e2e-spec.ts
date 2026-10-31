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
const DEFAULT_PRICE = { countryCode: 'CO', currency: 'COP', price: 19900, isDefault: true }
const DEFAULT_TAX = { taxName: 'IVA', taxRate: 0.19, isInclusive: true }

describe('Wallet payment reconciliation & expiration e2e (PostgreSQL, LOC-87)', () => {
  let moduleFixture: TestingModule
  let realDataSource: DataSource
  let checkoutService: CheckoutService
  let checkoutServiceB: CheckoutService
  let tasksService: TasksService
  let paymentRepo: Repository<Payment>
  let attemptRepo: Repository<PaymentAttempt>
  let walletRepo: Repository<Wallet>
  let txRepo: Repository<Transaction>
  let subRepo: Repository<Subscription>
  let subEventRepo: Repository<SubscriptionEvent>
  let assignPlanToBrandMock: jest.Mock
  let auditLogMock: jest.Mock

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

  const backdatePayments = (ids: string | string[], interval = '10 minutes') =>
    realDataSource.query(
      `UPDATE payments SET "createdAt" = NOW() - INTERVAL '${interval}' WHERE id = ANY($1::uuid[])`,
      [[ids].flat()],
    )

  const getPaymentStatus = async (id: string) => (await paymentRepo.findOneBy({ id }))!.status

  const seedWallet = (balance: number): Promise<Wallet> =>
    walletRepo.save(
      walletRepo.create({
        brandId: BRAND_ID,
        userId: '11111111-2222-4333-8444-555555555555',
        provider: 'internal',
        balance,
        currency: 'COP',
        status: WalletStatus.ACTIVE,
      }),
    )

  const seedActiveSub = (walletId: string, planSlug: string, extra: Partial<Subscription> = {}) => {
    const end = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    return subRepo.save(
      subRepo.create({
        brandId: BRAND_ID,
        userId: 'user-loc87-1',
        planSlug,
        status: SubscriptionStatus.ACTIVE,
        provider: SubscriptionProvider.WALLET,
        walletId,
        currentPeriodStart: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: end,
        nextBillingDate: end,
        retryCount: 0,
        autoRenew: true,
        ...extra,
      }),
    )
  }

  const buildCheckoutDto = (walletId: string, idempotencyKey: string) => ({
    brandId: BRAND_ID,
    userId: 'user-loc87-1',
    provider: 'wallet' as const,
    purpose: 'plan_purchase' as const,
    planSlug: 'dropi-roax',
    walletId,
    idempotencyKey,
  })

  const provokePostDebitCrash = async (walletId: string, key: string): Promise<Payment> => {
    const origCreateOrRenew = (checkoutService as any).createOrRenewSubscription.bind(
      checkoutService,
    )
    const origSave = paymentRepo.save.bind(paymentRepo)
    // R17: Spy on createOrRenewSubscription and paymentRepo.save to simulate a crash post-debit.
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
        checkoutService.processCheckout(buildCheckoutDto(walletId, key)),
      ).rejects.toThrow('Simulated process death before persisting COMPLETED')
    } finally {
      subSpy.mockRestore()
      saveSpy.mockRestore()
      ;(checkoutService as any).createOrRenewSubscription = origCreateOrRenew
    }
    const stuck = (await paymentRepo.findOneBy({ idempotencyKey: key }))!
    expect(stuck.status).toBe(PaymentStatus.PENDING)
    return stuck
  }

  const provokePreDebitCrash = async (walletId: string, key: string): Promise<Payment> => {
    // R17: Spy on attemptRepo.save to simulate a crash after PENDING save and before debit.
    const attemptSpy = jest
      .spyOn(attemptRepo, 'save')
      .mockRejectedValueOnce(new Error('Simulated crash before walletService.debit'))
    try {
      await expect(
        checkoutService.processCheckout(buildCheckoutDto(walletId, key)),
      ).rejects.toThrow('Simulated crash before walletService.debit')
    } finally {
      attemptSpy.mockRestore()
    }
    const stuck = (await paymentRepo.findOneBy({ idempotencyKey: key }))!
    expect(stuck.status).toBe(PaymentStatus.PENDING)
    return stuck
  }

  beforeAll(async () => {
    const readEntities = [Payment, Wallet, Transaction, BillingProfile]
    const entities = [
      ...readEntities,
      PaymentAttempt,
      WalletBalanceSnapshot,
      Subscription,
      SubscriptionEvent,
      WebhookEvent,
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

    // R17: Remote HTTP/Redis doubles isolate PostgreSQL persistence from external services.
    assignPlanToBrandMock = jest.fn().mockResolvedValue(true)
    auditLogMock = jest.fn().mockResolvedValue(null)
    moduleFixture = await Test.createTestingModule({
      providers: [
        CheckoutService,
        WalletService,
        TasksService,
        provideVal(getDataSourceToken('DBWrite'), realDataSource),
        ...entities.map((e) => provideRepo(e, 'DBWrite')),
        ...readEntities.map((e) => provideRepo(e, 'DBRead')),
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
        provideVal(AuditService, { log: auditLogMock }),
        provideVal(TaxService, { getTaxForCountry: jest.fn().mockResolvedValue(DEFAULT_TAX) }),
        provideVal(DianService, { isConfigured: () => false, sendInvoice: jest.fn() }),
        provideVal(ProviderFactory, { getProvider: jest.fn() }),
        provideVal(ProviderConfigService, {
          isProviderAvailable: jest.fn().mockResolvedValue(true),
        }),
        provideVal(EnterprisePricingService, { getForBrand: jest.fn().mockResolvedValue(null) }),
        provideVal(EventBusService, {
          publishPaymentCompleted: jest.fn(),
          notifyPaymentSuccess: jest.fn(),
          notifyInvoiceReady: jest.fn(),
        }),
        provideVal(WebhookService, { setCheckoutService: jest.fn() }),
        provideVal(ConfioSubscriptionWebhookService, {}),
      ],
    }).compile()

    checkoutService = moduleFixture.get(CheckoutService)
    checkoutServiceB = Object.assign(Object.create(CheckoutService.prototype), checkoutService, {
      walletReconcileLocks: new Map(),
    })
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

  it('completes a PENDING wallet payment whose debit committed before a crash once', async () => {
    // R15: red if reconcileWalletPayment charges debit without idempotencyKey or skips completion.
    const wallet = await seedWallet(100000)
    const stuckPayment = await provokePostDebitCrash(wallet.id, 'idem-loc87-crash-after-debit')
    await backdatePayments(stuckPayment.id)
    await tasksService.reconcileWalletPayments()

    const refreshedPayment = (await paymentRepo.findOneBy({ id: stuckPayment.id }))!
    expect(refreshedPayment.status).toBe(PaymentStatus.COMPLETED)
    expect(refreshedPayment.paidAt).toBeInstanceOf(Date)
    expect(refreshedPayment.metadata?.checkoutResult).toMatchObject({
      paymentId: stuckPayment.id,
      status: 'completed',
    })
    const sub = (await subRepo.findOneBy({ brandId: BRAND_ID }))!
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE)
    expect(sub.planSlug).toBe('dropi-roax')
    expect(sub.lastPaymentId).toBe(stuckPayment.id)
    expect(assignPlanToBrandMock).toHaveBeenCalledWith(BRAND_ID, 'dropi-roax', expect.any(Date))
    const refreshedWallet = (await walletRepo.findOneBy({ id: wallet.id }))!
    expect(Number(refreshedWallet.balance)).toBe(80100)
    const debits = await txRepo.findBy({ referenceId: stuckPayment.id })
    expect(debits).toHaveLength(1)
    expect(debits[0].idempotencyKey).toBe(`payment:${stuckPayment.id}:debit`)
  })

  it('marks a PENDING wallet payment without debit as failed without touching balance', async () => {
    // R15: red if reconcileWalletPayment skips setting FAILED or modifies the wallet balance.
    const wallet = await seedWallet(100000)
    const stuckPayment = await provokePreDebitCrash(wallet.id, 'idem-loc87-crash-before-debit')
    await backdatePayments(stuckPayment.id)
    await tasksService.reconcileWalletPayments()

    expect(await getPaymentStatus(stuckPayment.id)).toBe(PaymentStatus.FAILED)
    const refreshedWallet = (await walletRepo.findOneBy({ id: wallet.id }))!
    expect(Number(refreshedWallet.balance)).toBe(100000)
    expect(await txRepo.findBy({ walletId: wallet.id })).toHaveLength(0)
    expect(await subRepo.findOneBy({ brandId: BRAND_ID })).toBeNull()
  })

  it('serializes two simultaneous sweeps on a PROCESSING payment so effects run once', async () => {
    // R15: red if pg_advisory_xact_lock is removed, duplicating event, role, and audit calls.
    const wallet = await seedWallet(100000)
    await seedActiveSub(wallet.id, 'dropi-roax')

    const stuckPayment = await provokePostDebitCrash(wallet.id, 'idem-loc87-concurrent-sweep')
    await paymentRepo.update(stuckPayment.id, { status: PaymentStatus.PROCESSING })
    await backdatePayments(stuckPayment.id)
    assignPlanToBrandMock.mockClear()
    auditLogMock.mockClear()

    const origSubSave = subRepo.save.bind(subRepo)
    // R17: Delay subRepo.save by 30ms to force concurrent sweeps to overlap if unlocked.
    const subSaveSpy = jest.spyOn(subRepo, 'save').mockImplementation(async (entity: any) => {
      await new Promise((r) => setTimeout(r, 30))
      return origSubSave(entity)
    })
    try {
      await Promise.all([
        checkoutService.reconcileWalletPayment(stuckPayment.id),
        checkoutServiceB.reconcileWalletPayment(stuckPayment.id),
      ])
    } finally {
      subSaveSpy.mockRestore()
    }

    expect(await subEventRepo.findBy({ paymentId: stuckPayment.id })).toHaveLength(1)
    expect(assignPlanToBrandMock).toHaveBeenCalledTimes(1)
    expect(auditLogMock).toHaveBeenCalledTimes(1)
  })

  it('completes a sweep when subscription on another plan has an older payment or null lastPaymentId', async () => {
    // R15: red if findConflictingPlanSubscription blocks completion when lastPaymentId is older or null.
    const wallet = await seedWallet(100000)
    const stuckPayment = await provokePostDebitCrash(wallet.id, 'idem-loc87-conflict-old-plan')
    await backdatePayments(stuckPayment.id)
    const olderPayment = await paymentRepo.save(
      paymentRepo.create({
        ...stuckPayment,
        id: undefined,
        idempotencyKey: null as any,
        purposeId: 'growth',
        status: PaymentStatus.COMPLETED,
        paidAt: new Date(),
      }),
    )
    await realDataSource.query(
      'UPDATE payments SET "createdAt" = NOW() - INTERVAL \'20 minutes\', "paidAt" = NOW() - INTERVAL \'20 minutes\' WHERE id = $1',
      [olderPayment.id],
    )
    const sub = await seedActiveSub(wallet.id, 'growth', { lastPaymentId: olderPayment.id })
    assignPlanToBrandMock.mockClear()

    await tasksService.reconcileWalletPayments()
    expect(await getPaymentStatus(stuckPayment.id)).toBe(PaymentStatus.COMPLETED)
    const subAfterOlder = (await subRepo.findOneBy({ id: sub.id }))!
    expect(subAfterOlder.planSlug).toBe('dropi-roax')
    expect(subAfterOlder.lastPaymentId).toBe(stuckPayment.id)

    await subRepo.update(sub.id, { planSlug: 'growth', lastPaymentId: null as any })
    await paymentRepo.update(stuckPayment.id, { status: PaymentStatus.PROCESSING, metadata: {} })
    await subEventRepo.delete({ paymentId: stuckPayment.id })
    await tasksService.reconcileWalletPayments()
    expect(await getPaymentStatus(stuckPayment.id)).toBe(PaymentStatus.COMPLETED)
    expect((await subRepo.findOneBy({ id: sub.id }))!.planSlug).toBe('dropi-roax')
  })

  it('does not expire a debited PENDING wallet payment and allows the sweep to complete it', async () => {
    // R15: red if expirePendingCheckouts updates PENDING payments with a committed debit to FAILED.
    const wallet = await seedWallet(100000)
    const debitedPayment = await provokePostDebitCrash(wallet.id, 'idem-loc87-expire-with-debit')
    const unpaidPayment = await provokePreDebitCrash(wallet.id, 'idem-loc87-expire-without-debit')
    await backdatePayments([debitedPayment.id, unpaidPayment.id], '25 hours')

    await tasksService.expirePendingCheckouts()

    expect(await getPaymentStatus(debitedPayment.id)).toBe(PaymentStatus.PENDING)
    expect(await getPaymentStatus(unpaidPayment.id)).toBe(PaymentStatus.FAILED)

    await tasksService.reconcileWalletPayments()

    expect(await getPaymentStatus(debitedPayment.id)).toBe(PaymentStatus.COMPLETED)
    const sub = (await subRepo.findOneBy({ brandId: BRAND_ID }))!
    expect(sub.status).toBe(SubscriptionStatus.ACTIVE)
    const refreshedWallet = (await walletRepo.findOneBy({ id: wallet.id }))!
    expect(Number(refreshedWallet.balance)).toBe(80100)
  })
})
