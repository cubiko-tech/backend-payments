import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { DataSource, Repository } from 'typeorm'

import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
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
import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { TasksService } from '../src/tasks/tasks.service'
import { TaxService } from '../src/tax/tax.service'
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { WalletService } from '../src/wallet/wallet.service'
import { ConfioSubscriptionWebhookService } from '../src/webhook/confio-subscription-webhook.service'
import { WebhookEvent } from '../src/webhook/entities/webhookEvent.entity'
import { WebhookService } from '../src/webhook/webhook.service'

const BRAND_ID = 'f8969696-2222-4333-8444-555555555555'
const DEFAULT_PRICE = { countryCode: 'CO', currency: 'COP', price: 19900, isDefault: true }
const DEFAULT_TAX = { taxName: 'IVA', taxRate: 0.19, isInclusive: true }
const READ_ENTITIES = [Payment, Wallet, Transaction, BillingProfile, AuditLog]
const EXTRA_ENTITIES = [PaymentAttempt, WalletBalanceSnapshot, Subscription, SubscriptionEvent]
const WRITE_ENTITIES = [...READ_ENTITIES, ...EXTRA_ENTITIES, WebhookEvent]

async function compileSupersededE2eModule(realDataSource: DataSource, assignPlanMock: jest.Mock) {
  const provideRepo = (entity: any, conn = 'DBWrite') => ({
    provide: getRepositoryToken(entity, conn),
    useValue: realDataSource.getRepository(entity),
  })
  const provideVal = (provide: any, useValue: any) => ({ provide, useValue })
  const invRes = { data: { id: 'inv-96', invoiceNumber: 'CK-96' } }
  // R17: External HTTP/Redis service doubles isolate PostgreSQL persistence from remote services.
  return Test.createTestingModule({
    providers: [
      CheckoutService,
      WalletService,
      AuditService,
      TasksService,
      provideVal(getDataSourceToken('DBWrite'), realDataSource),
      ...WRITE_ENTITIES.map((e) => provideRepo(e, 'DBWrite')),
      ...READ_ENTITIES.map((e) => provideRepo(e, 'DBRead')),
      provideVal(ClientPlatformService, {
        canViewBrandCredit: jest.fn().mockResolvedValue(true),
        resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }),
        getBrandCountry: jest.fn().mockResolvedValue('CO'),
      }),
      provideVal(ClientRolesService, {
        getPlanPrice: jest.fn().mockResolvedValue(19900),
        resolvePriceForCountry: jest.fn().mockResolvedValue({ ok: true, price: DEFAULT_PRICE }),
        assignPlanToBrand: assignPlanMock,
      }),
      provideVal(InvoiceService, { create: jest.fn().mockResolvedValue(invRes) }),
      provideVal(SubscriptionService, {}),
      provideVal(TaxService, { getTaxForCountry: jest.fn().mockResolvedValue(DEFAULT_TAX) }),
      provideVal(DianService, { isConfigured: () => false, sendInvoice: jest.fn() }),
      provideVal(ProviderFactory, { getProvider: jest.fn() }),
      provideVal(ProviderConfigService, { isProviderAvailable: jest.fn().mockResolvedValue(true) }),
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
}

describe('Superseded wallet payment refund reconciliation e2e (PostgreSQL, LOC-96)', () => {
  let moduleFixture: TestingModule
  let realDataSource: DataSource
  let checkoutService: CheckoutService
  let checkoutServiceB: CheckoutService
  let tasksService: TasksService
  let paymentRepo: Repository<Payment>
  let walletRepo: Repository<Wallet>
  let txRepo: Repository<Transaction>
  let subRepo: Repository<Subscription>
  let auditLogRepo: Repository<AuditLog>
  let assignPlanToBrandMock: jest.Mock

  const cleanupBrandData = async () => {
    if (!realDataSource?.isInitialized) return
    for (const sql of [
      'DELETE FROM audit_log WHERE "entityType" = \'payment\' AND "entityId" IN (SELECT id::text FROM payments WHERE "brandId" = $1)',
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

  const backdatePayment = (id: string, interval = '10 minutes') =>
    realDataSource.query(
      `UPDATE payments SET "createdAt" = NOW() - INTERVAL '${interval}' WHERE id = $1`,
      [id],
    )
  const getWalletBalance = async (id: string) =>
    Number((await walletRepo.findOneBy({ id }))!.balance)
  const getPaymentStatus = async (id: string) => (await paymentRepo.findOneBy({ id }))!.status
  const findPaymentCredits = (paymentId: string) =>
    txRepo.findBy({ referenceId: paymentId, type: TransactionType.CREDIT })
  const seedWallet = (balance = 100000): Promise<Wallet> => {
    const base = { brandId: BRAND_ID, userId: BRAND_ID, provider: 'internal', currency: 'COP' }
    return walletRepo.save(walletRepo.create({ ...base, balance, status: WalletStatus.ACTIVE }))
  }
  const buildCheckoutDto = (walletId: string, idempotencyKey: string, planSlug = 'dropi-roax') => {
    const base = { brandId: BRAND_ID, userId: 'user-loc96-1', provider: 'wallet' as const }
    return { ...base, purpose: 'plan_purchase' as const, planSlug, walletId, idempotencyKey }
  }
  const purchasePlan = (walletId: string, idempotencyKey: string, planSlug: string) =>
    checkoutService.processCheckout(buildCheckoutDto(walletId, idempotencyKey, planSlug))

  const provokePostDebitCrash = async (walletId: string, key: string, planSlug = 'dropi-roax') => {
    const origSub = (checkoutService as any).createOrRenewSubscription.bind(checkoutService)
    const origUpdate = paymentRepo.update.bind(paymentRepo)
    // R17: A failed close whose hand-over write fails too leaves what a dead process leaves.
    const subSpy = jest
      .spyOn(checkoutService as any, 'createOrRenewSubscription')
      .mockRejectedValueOnce(new Error('Simulated crash after wallet debit commit'))
    const saveSpy = jest
      .spyOn(paymentRepo, 'update')
      .mockImplementation(async (criteria: any, partial: any) => {
        if (partial?.status === PaymentStatus.PROCESSING) throw new Error('Simulated process death')
        return origUpdate(criteria, partial)
      })
    try {
      await expect(purchasePlan(walletId, key, planSlug)).rejects.toThrow(
        'Simulated crash after wallet debit commit',
      )
    } finally {
      subSpy.mockRestore()
      saveSpy.mockRestore()
      ;(checkoutService as any).createOrRenewSubscription = origSub
    }
    const stuck = (await paymentRepo.findOneBy({ idempotencyKey: key }))!
    expect(stuck.status).toBe(PaymentStatus.PENDING)
    return stuck
  }

  const runSweepWithFailedRefundUpdate = async () => {
    const origUpdate = paymentRepo.update.bind(paymentRepo)
    let failedOnce = false
    // R17: Fail the first status update to REFUNDED after credit commits so the next sweep retries.
    const updateSpy = jest
      .spyOn(paymentRepo, 'update')
      .mockImplementation(async (criteria: any, partial: any) => {
        if (!failedOnce && partial?.status === PaymentStatus.REFUNDED) {
          failedOnce = true
          throw new Error('Simulated DB interruption before marking payment REFUNDED')
        }
        return origUpdate(criteria, partial)
      })
    try {
      await tasksService.reconcileWalletPayments()
    } finally {
      updateSpy.mockRestore()
    }
  }

  beforeAll(async () => {
    realDataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB,
      entities: WRITE_ENTITIES,
      synchronize: false,
    })
    await realDataSource.initialize()
    paymentRepo = realDataSource.getRepository(Payment)
    walletRepo = realDataSource.getRepository(Wallet)
    txRepo = realDataSource.getRepository(Transaction)
    subRepo = realDataSource.getRepository(Subscription)
    auditLogRepo = realDataSource.getRepository(AuditLog)

    // R17: Mock ClientRolesService.assignPlanToBrand to observe role sync calls without HTTP.
    assignPlanToBrandMock = jest.fn().mockResolvedValue(true)
    moduleFixture = await compileSupersededE2eModule(realDataSource, assignPlanToBrandMock)
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

  it('credits the wallet once and marks the payment refunded when a newer checkout is on another plan (active or expired)', async () => {
    // R15: red if refundSupersededWalletPayment fails to credit the wallet or leaves status in PROCESSING.
    const wallet = await seedWallet(100000)
    const stuck = await provokePostDebitCrash(wallet.id, 'idem-loc96-stuck-1', 'dropi-roax')
    await backdatePayment(stuck.id)

    const newerRes = await purchasePlan(wallet.id, 'idem-loc96-newer-growth', 'growth')
    expect(newerRes.status).toBe('completed')
    assignPlanToBrandMock.mockClear()

    await tasksService.reconcileWalletPayments()

    const refunded = (await paymentRepo.findOneBy({ id: stuck.id }))!
    expect(refunded.status).toBe(PaymentStatus.REFUNDED)
    expect(refunded.metadata?.checkoutResult).toBeUndefined()
    expect(await getWalletBalance(wallet.id)).toBe(80100)
    expect(assignPlanToBrandMock).not.toHaveBeenCalled()

    const retryCheckout = await purchasePlan(wallet.id, 'idem-loc96-stuck-1', 'dropi-roax')
    expect(retryCheckout).toEqual({ paymentId: stuck.id, status: 'refunded' })
    expect(await checkoutService.reconcilePayment(stuck.id, null)).toEqual({ status: 'refunded' })

    const sub = (await subRepo.findOneBy({ brandId: BRAND_ID }))!
    await subRepo.update(sub.id, { status: SubscriptionStatus.EXPIRED, autoRenew: false })
    const stuckExpired = await provokePostDebitCrash(wallet.id, 'idem-loc96-stuck-2', 'dropi-roax')
    await backdatePayment(stuckExpired.id)
    await tasksService.reconcileWalletPayments()

    expect(await getPaymentStatus(stuckExpired.id)).toBe(PaymentStatus.REFUNDED)
    expect(await getWalletBalance(wallet.id)).toBe(80100)
    const subAfter = (await subRepo.findOneBy({ id: sub.id }))!
    expect(subAfter.planSlug).toBe('growth')
    expect(subAfter.status).toBe(SubscriptionStatus.EXPIRED)
  })

  it('persists the refund CREDIT transaction and wallet_payment_refunded audit_log entry in PostgreSQL', async () => {
    // R15: red if refundSupersededWalletPayment skips the CREDIT movement or the audit_log record.
    const wallet = await seedWallet(100000)
    const stuck = await provokePostDebitCrash(wallet.id, 'idem-loc96-trail-stuck', 'dropi-roax')
    await backdatePayment(stuck.id)
    await purchasePlan(wallet.id, 'idem-loc96-trail-newer', 'growth')

    await tasksService.reconcileWalletPayments()

    const credits = await findPaymentCredits(stuck.id)
    expect(credits).toHaveLength(1)
    expect(credits[0]).toMatchObject({
      walletId: wallet.id,
      brandId: BRAND_ID,
      type: TransactionType.CREDIT,
      status: TransactionStatus.COMPLETED,
      category: 'refund',
      referenceType: 'payment',
      referenceId: stuck.id,
    })
    expect(Number(credits[0].amount)).toBe(19900)

    const audits = await auditLogRepo.findBy({
      entityType: 'payment',
      entityId: stuck.id,
      action: 'wallet_payment_refunded',
    })
    expect(audits).toHaveLength(1)
    expect(audits[0].changes).toMatchObject({
      planSlug: 'dropi-roax',
      conflictingPlanSlug: 'growth',
      walletId: wallet.id,
      amount: 19900,
      idempotencyKey: `payment:${stuck.id}:refund`,
      provider: 'wallet',
      reconciled: true,
    })
  })

  it('uses deterministic idempotency key payment:<id>:refund so a retry after a failed status update or two simultaneous sweeps credit only once', async () => {
    // R15: red if idempotencyKey: refundKey is removed from walletService.credit, crediting twice on retry.
    const wallet = await seedWallet(100000)
    const stuck = await provokePostDebitCrash(wallet.id, 'idem-loc96-idem-retry', 'dropi-roax')
    await backdatePayment(stuck.id)
    await purchasePlan(wallet.id, 'idem-loc96-idem-newer', 'growth')

    await runSweepWithFailedRefundUpdate()
    expect(await getPaymentStatus(stuck.id)).toBe(PaymentStatus.PROCESSING)

    await tasksService.reconcileWalletPayments()

    expect(await getPaymentStatus(stuck.id)).toBe(PaymentStatus.REFUNDED)
    const credits = await findPaymentCredits(stuck.id)
    expect(credits).toHaveLength(1)
    expect(credits[0].idempotencyKey).toBe(`payment:${stuck.id}:refund`)
    expect(await getWalletBalance(wallet.id)).toBe(80100)

    const stuckConcurrent = await provokePostDebitCrash(
      wallet.id,
      'idem-loc96-idem-concurrent',
      'dropi-roax',
    )
    await paymentRepo.update(stuckConcurrent.id, { status: PaymentStatus.PROCESSING })
    await backdatePayment(stuckConcurrent.id)
    await Promise.all([
      checkoutService.reconcileWalletPayment(stuckConcurrent.id),
      checkoutServiceB.reconcileWalletPayment(stuckConcurrent.id),
    ])
    expect(await findPaymentCredits(stuckConcurrent.id)).toHaveLength(1)
    expect(await getWalletBalance(wallet.id)).toBe(80100)
  })

  it('keeps the payment in PROCESSING when walletService.credit fails and refunds it on the next sweep', async () => {
    // R15: red if a credit error transitions the payment to REFUNDED or FAILED instead of keeping PROCESSING.
    const wallet = await seedWallet(100000)
    const stuck = await provokePostDebitCrash(wallet.id, 'idem-loc96-credit-fail', 'dropi-roax')
    await backdatePayment(stuck.id)
    await purchasePlan(wallet.id, 'idem-loc96-credit-fail-newer', 'growth')

    await walletRepo.update(wallet.id, { status: WalletStatus.CLOSED })
    // R17: Spy on CheckoutService log.error to verify credit failure is logged while keeping PROCESSING.
    const errorLogSpy = jest.spyOn((checkoutService as any).log, 'error')
    try {
      await tasksService.reconcileWalletPayments()
      expect(await getPaymentStatus(stuck.id)).toBe(PaymentStatus.PROCESSING)
      expect(await findPaymentCredits(stuck.id)).toHaveLength(0)
      expect(errorLogSpy).toHaveBeenCalledWith(expect.stringContaining(stuck.id))
    } finally {
      errorLogSpy.mockRestore()
      await walletRepo.update(wallet.id, { status: WalletStatus.ACTIVE })
    }

    await tasksService.reconcileWalletPayments()
    expect(await getPaymentStatus(stuck.id)).toBe(PaymentStatus.REFUNDED)
    expect(await findPaymentCredits(stuck.id)).toHaveLength(1)
    expect(await getWalletBalance(wallet.id)).toBe(80100)
  })

  it('completes a debited wallet payment normally when no newer conflicting purchase exists', async () => {
    // R15: red if refundSupersededWalletPayment runs when there is no conflicting newer subscription.
    const wallet = await seedWallet(100000)
    const stuck = await provokePostDebitCrash(wallet.id, 'idem-loc96-no-conflict', 'dropi-roax')
    await backdatePayment(stuck.id)

    await tasksService.reconcileWalletPayments()

    expect(await getPaymentStatus(stuck.id)).toBe(PaymentStatus.COMPLETED)
    expect(await findPaymentCredits(stuck.id)).toHaveLength(0)
    expect((await subRepo.findOneBy({ brandId: BRAND_ID }))!.planSlug).toBe('dropi-roax')
    expect(await getWalletBalance(wallet.id)).toBe(80100)
  })

  it('transitions a payment to refunded instead of completed when its refund credit was already recorded before the brand repurchased the same plan', async () => {
    // R15: red if reconcileWalletPayment ignores an existing payment:<id>:refund credit after the brand repurchases the same plan.
    const wallet = await seedWallet(150000)
    const stuck = await provokePostDebitCrash(wallet.id, 'idem-loc96-rebound-stuck', 'dropi-roax')
    await backdatePayment(stuck.id)
    await purchasePlan(wallet.id, 'idem-loc96-rebound-growth', 'growth')

    await runSweepWithFailedRefundUpdate()
    expect(await getPaymentStatus(stuck.id)).toBe(PaymentStatus.PROCESSING)
    expect(await findPaymentCredits(stuck.id)).toHaveLength(1)

    const repurchased = await purchasePlan(wallet.id, 'idem-loc96-rebound-same', 'dropi-roax')
    expect(repurchased.status).toBe('completed')
    const subBefore = (await subRepo.findOneBy({ brandId: BRAND_ID }))!
    const periodEndBefore = subBefore.currentPeriodEnd.toISOString()
    assignPlanToBrandMock.mockClear()

    await tasksService.reconcileWalletPayments()

    expect(await getPaymentStatus(stuck.id)).toBe(PaymentStatus.REFUNDED)
    expect(await findPaymentCredits(stuck.id)).toHaveLength(1)
    expect(await getWalletBalance(wallet.id)).toBe(110200)
    expect(assignPlanToBrandMock).not.toHaveBeenCalled()
    const subAfter = (await subRepo.findOneBy({ brandId: BRAND_ID }))!
    expect(subAfter.planSlug).toBe('dropi-roax')
    expect(subAfter.currentPeriodEnd.toISOString()).toBe(periodEndBefore)
  })
})
