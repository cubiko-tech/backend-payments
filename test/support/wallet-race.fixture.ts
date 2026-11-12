import { randomUUID } from 'crypto'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'

import { AddTokenGiftNotices1794350000000 } from '../../migrations/1794350000000-AddTokenGiftNotices'
import { AuditService } from '../../src/audit/audit.service'
import { AuditLog } from '../../src/audit/entities/auditLog.entity'
import { BillingProfile } from '../../src/billing-profile/entities/billingProfile.entity'
import { CheckoutService } from '../../src/checkout/checkout.service'
import { CountryBillingConfigService } from '../../src/billing-profile/country-billing-config.service'
import { CountryBillingConfig } from '../../src/billing-profile/entities/countryBillingConfig.entity'
import { ClientPlatformService } from '../../src/client/client-platform.service'
import { ClientRolesService } from '../../src/client/client-roles.service'
import { DianService } from '../../src/dian/dian.service'
import { EventBusService } from '../../src/event-bus/event-bus.service'
import { Invoice } from '../../src/invoice/entities/invoice.entity'
import { InvoiceItem } from '../../src/invoice/entities/invoiceItem.entity'
import { InvoiceService } from '../../src/invoice/invoice.service'
import { Payment } from '../../src/payment/entities/payment.entity'
import { PaymentAttempt } from '../../src/payment/entities/paymentAttempt.entity'
import { PaymentService } from '../../src/payment/payment.service'
import { ProviderConfigService } from '../../src/provider/provider-config.service'
import { ProviderFactory } from '../../src/provider/provider.factory'
import { EnterprisePricingService } from '../../src/subscription/enterprise-pricing.service'
import { Subscription } from '../../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionService } from '../../src/subscription/subscription.service'
import { TasksService } from '../../src/tasks/tasks.service'
import { TaxService } from '../../src/tax/tax.service'
import { Transaction, TransactionType } from '../../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../../src/wallet/entities/walletBalanceSnapshot.entity'
import { WalletService } from '../../src/wallet/wallet.service'
import { TokenGiftNotice } from '../../src/wallet/entities/token-gift-notice.entity'
import { TokenPackage } from '../../src/wallet/entities/token-package.entity'
import { TokenPackageService } from '../../src/wallet/token-package.service'
import { TokenWalletService } from '../../src/wallet/token-wallet.service'
import { TRM_SOURCE_URL, TrmService } from '../../src/trm/trm.service'
import { ConfioSubscriptionWebhookService } from '../../src/webhook/confio-subscription-webhook.service'
import { WebhookEvent } from '../../src/webhook/entities/webhookEvent.entity'
import { WebhookService } from '../../src/webhook/webhook.service'

const READ_ENTITIES = [
  Payment,
  Wallet,
  Transaction,
  BillingProfile,
  AuditLog,
  Invoice,
  CountryBillingConfig,
]
const WRITE_ENTITIES = [
  ...READ_ENTITIES,
  InvoiceItem,
  PaymentAttempt,
  WalletBalanceSnapshot,
  Subscription,
  SubscriptionEvent,
  WebhookEvent,
  TokenPackage,
  TokenGiftNotice,
]
const DEFAULT_PRICE = { countryCode: 'CO', currency: 'COP', price: 19900, isDefault: true }
const DEFAULT_TAX = { taxName: 'IVA', taxRate: 0.19, isInclusive: true }

export const PLAN_PRICE = 19900

// Jest evaluates this module once per test file, so the name tells this suite's sessions apart.
const SUITE_APPLICATION_NAME = `roax-e2e-${process.pid}-${randomUUID().slice(0, 8)}`

/**
 * PostgreSQL options of a race instance. Every connection carries this suite's application name,
 * which is what the wait helpers below count.
 */
export function raceConnectionOptions() {
  return {
    type: 'postgres' as const,
    host: process.env.POSTGRES_HOST || '127.0.0.1',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    username: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'postgres',
    database: process.env.POSTGRES_DB,
    applicationName: SUITE_APPLICATION_NAME,
    synchronize: false,
  }
}

/** One service instance: its own connection pool and Nest module, sharing only PostgreSQL. */
export interface RaceInstance {
  dataSource: DataSource
  moduleRef: TestingModule
  checkout: CheckoutService
  tasks: TasksService
  wallet: WalletService
  payments: PaymentService
  assignPlan: jest.Mock
}

/**
 * With `realBilling`, invoices and credit notes are rows and the DIAN answers through its mock.
 * With `trmUrl`, token packages can be bought: the real catalog and token wallet, and the TRM
 * read from that URL.
 */
export async function startInstance(
  options: { realBilling?: boolean; trmUrl?: string } = {},
): Promise<RaceInstance> {
  const dataSource = new DataSource({ ...raceConnectionOptions(), entities: WRITE_ENTITIES })
  await dataSource.initialize()
  const hasNotices = await dataSource.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'token_gift_notices'`,
  )
  if (!hasNotices.length) {
    const runner = dataSource.createQueryRunner()
    try {
      await new AddTokenGiftNotices1794350000000().up(runner)
    } finally {
      await runner.release()
    }
  }

  const provideRepo = (entity: any, conn: string) => ({
    provide: getRepositoryToken(entity, conn),
    useValue: dataSource.getRepository(entity),
  })
  const provideVal = (provide: any, useValue: any) => ({ provide, useValue })
  const assignPlan = jest.fn().mockResolvedValue(true)
  const invoice = { data: { id: 'inv-97', invoiceNumber: 'CK-97' } }
  // R17: HTTP and Redis services are remote; only PostgreSQL decides these races.
  const moduleRef = await Test.createTestingModule({
    providers: [
      CheckoutService,
      WalletService,
      AuditService,
      TasksService,
      PaymentService,
      provideVal(getDataSourceToken('DBWrite'), dataSource),
      ...WRITE_ENTITIES.map((e) => provideRepo(e, 'DBWrite')),
      ...READ_ENTITIES.map((e) => provideRepo(e, 'DBRead')),
      provideVal(ClientPlatformService, {
        canViewBrandCredit: jest.fn().mockResolvedValue(true),
        resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }),
        getBrandCountry: jest.fn().mockResolvedValue('CO'),
      }),
      provideVal(ClientRolesService, {
        getPlanPrice: jest.fn().mockResolvedValue(PLAN_PRICE),
        resolvePriceForCountry: jest.fn().mockResolvedValue({ ok: true, price: DEFAULT_PRICE }),
        assignPlanToBrand: assignPlan,
        renewPlanForBrand: jest.fn().mockResolvedValue(true),
      }),
      ...(options.realBilling
        ? [InvoiceService, DianService, CountryBillingConfigService]
        : [
            provideVal(InvoiceService, {
              create: jest.fn().mockResolvedValue(invoice),
              findInvoiceOfPayment: jest.fn().mockResolvedValue(null),
            }),
            provideVal(DianService, { isConfigured: () => false, sendInvoice: jest.fn() }),
          ]),
      ...(options.trmUrl
        ? [
            TokenWalletService,
            TokenPackageService,
            TrmService,
            provideVal(TRM_SOURCE_URL, options.trmUrl),
          ]
        : []),
      provideVal(SubscriptionService, {}),
      provideVal(TaxService, { getTaxForCountry: jest.fn().mockResolvedValue(DEFAULT_TAX) }),
      provideVal(ProviderFactory, { getProvider: jest.fn() }),
      provideVal(ProviderConfigService, { isProviderAvailable: jest.fn().mockResolvedValue(true) }),
      provideVal(EnterprisePricingService, { getForBrand: jest.fn().mockResolvedValue(null) }),
      provideVal(EventBusService, {
        publishPaymentCompleted: jest.fn(),
        notifyPaymentSuccess: jest.fn(),
        notifyInvoiceReady: jest.fn(),
        publishSubscriptionRenewed: jest.fn(),
        notifyPaymentFailed: jest.fn(),
      }),
      provideVal(WebhookService, { setCheckoutService: jest.fn() }),
      provideVal(ConfioSubscriptionWebhookService, {}),
    ],
  }).compile()
  if (options.realBilling) {
    // A configured .env must not reach the real Siigo from a test.
    ;(moduleRef.get(DianService) as any).providers.delete('siigo')
  }

  return {
    dataSource,
    moduleRef,
    checkout: moduleRef.get(CheckoutService),
    tasks: moduleRef.get(TasksService),
    wallet: moduleRef.get(WalletService),
    payments: moduleRef.get(PaymentService),
    assignPlan,
  }
}

export async function stopInstance(instance?: RaceInstance): Promise<void> {
  await instance?.moduleRef.close()
  if (instance?.dataSource.isInitialized) await instance.dataSource.destroy()
}

export async function cleanBrand(dataSource: DataSource, brandId: string): Promise<void> {
  for (const sql of [
    'DELETE FROM token_gift_notices WHERE "brandId" = $1',
    'DELETE FROM audit_log WHERE "entityType" = \'payment\' AND "entityId" IN (SELECT id::text FROM payments WHERE "brandId" = $1)',
    'DELETE FROM audit_log WHERE "entityType" = \'wallet\' AND "entityId" IN (SELECT id::text FROM wallets WHERE "brandId" = $1)',
    'DELETE FROM subscription_events WHERE "subscriptionId" IN (SELECT id FROM subscriptions WHERE "brandId" = $1)',
    'DELETE FROM subscriptions WHERE "brandId" = $1',
    'DELETE FROM payment_attempts WHERE "paymentId" IN (SELECT id FROM payments WHERE "brandId" = $1)',
    'DELETE FROM transactions WHERE "brandId" = $1',
    'DELETE FROM payments WHERE "brandId" = $1',
    'DELETE FROM wallets WHERE "brandId" = $1',
    // A recharge from Dropi charged as manual leaves its invoice (LOC-206).
    'DELETE FROM invoices WHERE "brandId" = $1',
  ]) {
    await dataSource.query(sql, [brandId])
  }
}

export function seedWallet(dataSource: DataSource, brandId: string, balance = 100000) {
  const repo = dataSource.getRepository(Wallet)
  const base = { brandId, userId: brandId, provider: 'internal', currency: 'COP' }
  return repo.save(repo.create({ ...base, balance, status: WalletStatus.ACTIVE }))
}

export function planCheckout(brandId: string, walletId: string, key: string, planSlug: string) {
  const base = { brandId, userId: 'user-loc97', provider: 'wallet' as const }
  return { ...base, purpose: 'plan_purchase' as const, planSlug, walletId, idempotencyKey: key }
}

export function backdate(dataSource: DataSource, paymentId: string, interval = '10 minutes') {
  return dataSource.query(
    `UPDATE payments SET "createdAt" = NOW() - INTERVAL '${interval}' WHERE id = $1`,
    [paymentId],
  )
}

/**
 * Sweeps one payment as if `ageMs` had passed. Moves the clock and not the row, so the sweep
 * of a spec running in parallel does not pick it up and close it without this spec's failure.
 */
export function sweepAfter(instance: RaceInstance, paymentId: string, ageMs: number) {
  return instance.checkout.reconcileWalletPayment(paymentId, new Date(Date.now() + ageMs))
}

export async function findPaymentByKey(dataSource: DataSource, key: string): Promise<Payment> {
  return (await dataSource.getRepository(Payment).findOneBy({ idempotencyKey: key }))!
}

export async function statusOf(dataSource: DataSource, paymentId: string) {
  return (await dataSource.getRepository(Payment).findOneBy({ id: paymentId }))!.status
}

export async function balanceOf(dataSource: DataSource, walletId: string) {
  return Number((await dataSource.getRepository(Wallet).findOneBy({ id: walletId }))!.balance)
}

export function movements(dataSource: DataSource, paymentId: string, type: TransactionType) {
  return dataSource.getRepository(Transaction).findBy({ referenceId: paymentId, type })
}

/** A point where a checkout parks: `reached` resolves when it arrives, `release` lets it go. */
export interface Gate {
  reached: Promise<void>
  arrive: () => void
  wait: Promise<void>
  release: () => void
}

export function createGate(): Gate {
  let arrive!: () => void
  let release!: () => void
  const reached = new Promise<void>((resolve) => {
    arrive = resolve
  })
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { reached, arrive, wait, release }
}

/** Parks the first call of `target[method]` at the gate, then runs the real method. */
export function parkFirstCall(target: any, method: string, gate: Gate): jest.SpyInstance {
  const original = target[method].bind(target)
  let parked = false
  // R17: Holding a real call open is the only way to provoke this interleaving on demand.
  return jest.spyOn(target, method).mockImplementation(async (...args: unknown[]) => {
    if (!parked) {
      parked = true
      gate.arrive()
      await gate.wait
    }
    return original(...args)
  })
}

/** Polls `sql` (with the suite's application name as $1) until it returns a row or time runs out. */
async function suiteSessionMatches(dataSource: DataSource, sql: string, timeoutMs: number) {
  const name = (dataSource.options as { applicationName?: string }).applicationName
  if (!name) throw new Error('The wait helpers need a connection from raceConnectionOptions()')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await dataSource.query(sql, [name])).length > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/**
 * True once a session of this suite (any instance built from `raceConnectionOptions()`) is blocked
 * on a row lock; false if none blocks in time. Waits of other suites on the same database do not count.
 */
export function someoneWaitsOnRowLock(dataSource: DataSource, timeoutMs = 3000) {
  return suiteSessionMatches(
    dataSource,
    `SELECT 1 FROM pg_stat_activity
     WHERE wait_event_type = 'Lock' AND datname = current_database() AND application_name = $1`,
    timeoutMs,
  )
}

/** Like `someoneWaitsOnRowLock`, true once at least `count` sessions of this suite are blocked. */
export function sessionsWaitOnRowLock(dataSource: DataSource, count: number, timeoutMs = 3000) {
  return suiteSessionMatches(
    dataSource,
    `SELECT 1 FROM pg_stat_activity
     WHERE wait_event_type = 'Lock' AND datname = current_database() AND application_name = $1
     HAVING count(*) >= ${Math.trunc(count)}`,
    timeoutMs,
  )
}

/** Like `someoneWaitsOnRowLock`, for a session of this suite blocked on an advisory lock. */
export function someoneWaitsOnAdvisoryLock(dataSource: DataSource, timeoutMs = 3000) {
  return suiteSessionMatches(
    dataSource,
    `SELECT 1 FROM pg_locks l
     JOIN pg_database d ON d.oid = l.database
     JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = current_database()
       AND a.application_name = $1`,
    timeoutMs,
  )
}
