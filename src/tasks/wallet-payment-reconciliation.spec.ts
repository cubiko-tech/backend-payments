import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants'

import { CheckoutService } from '../checkout/checkout.service'
import { PaymentProvider, PaymentPurpose, PaymentStatus } from '../payment/entities/payment.entity'
import {
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { TransactionStatus, TransactionType } from '../transaction/entities/transaction.entity'
import { TasksService } from './tasks.service'

describe('Wallet payment reconciliation and expiration safety (LOC-87)', () => {
  const buildState = () => {
    const payments = new Map<string, any>()
    const subscriptions = new Map<string, any>()
    const subscriptionEvents: any[] = []
    const transactions: any[] = []
    const walletBalances = new Map<string, number>([['wallet-1', 100000]])
    let advisoryChain = Promise.resolve()

    const seedPayment = (id: string, overrides: Record<string, any> = {}) => {
      const row = {
        id,
        brandId: '101',
        userId: 'user-1',
        walletId: 'wallet-1',
        amount: 49000,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        provider: PaymentProvider.WALLET,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: 'growth',
        createdAt: new Date(Date.now() - 10 * 60 * 1000),
        ...overrides,
      }
      payments.set(id, row)
      return row
    }

    const beforeDate = (val: any, cutoff: any) =>
      !(cutoff instanceof Date) || new Date(val).getTime() < cutoff.getTime()

    // R17: in-memory Payment repo double to test TasksService and CheckoutService without a live DB.
    const paymentRepo: any = {
      find: jest.fn(async ({ where }: any = {}) =>
        Array.from(payments.values()).filter((p) => {
          const allowed = where?.status ? [where.status._value ?? where.status].flat() : null
          return (
            (!where?.provider || p.provider === where.provider) &&
            (!allowed || allowed.includes(p.status)) &&
            beforeDate(p.createdAt, where?.createdAt?._value)
          )
        }),
      ),
      findOne: jest.fn(async ({ where }: any = {}) =>
        payments.has(where?.id) ? { ...payments.get(where?.id) } : null,
      ),
      update: jest.fn(async (criteria: any, partial: any) => {
        const ids: string[] = [
          criteria?.id?._value ?? criteria?.id ?? Array.from(payments.keys()),
        ].flat()
        let affected = 0
        for (const id of ids) {
          const cur = payments.get(id)
          if (!cur || (criteria?.status && cur.status !== criteria.status)) continue
          if (!beforeDate(cur.createdAt, criteria?.createdAt?._value)) continue
          payments.set(id, { ...cur, ...partial })
          affected++
        }
        return { affected }
      }),
      save: jest.fn(async (entity: any) => {
        payments.set(entity.id, { ...entity })
        return entity
      }),
    }

    // R17: stateful Subscription and SubscriptionEvent doubles to verify single execution on races.
    const subscriptionRepo: any = {
      findOne: jest.fn(async ({ where }: any = {}) => {
        const sub = Array.from(subscriptions.values()).find(
          (s) => s.brandId === where?.brandId || s.id === where?.id,
        )
        return sub ? { ...sub } : null
      }),
      create: jest.fn((data: any) => ({ id: `sub-${subscriptions.size + 1}`, ...data })),
      save: jest.fn(async (sub: any) => {
        await new Promise((r) => setTimeout(r, 10))
        subscriptions.set(sub.id, { ...sub })
        return sub
      }),
    }
    const subscriptionEventRepo: any = {
      findOne: jest.fn(
        async ({ where }: any = {}) =>
          subscriptionEvents.find((e) => e.paymentId === where?.paymentId) ?? null,
      ),
      create: jest.fn((data: any) => ({ id: `evt-${subscriptionEvents.length + 1}`, ...data })),
      save: jest.fn(async (evt: any) => (subscriptionEvents.push(evt), evt)),
    }

    // R17: Transaction read repo and WalletService doubles track wallet balance and debit rows.
    const findTxByKey = async ({ where }: any = {}) =>
      transactions.find((t) => t.idempotencyKey === where?.idempotencyKey) ?? null
    const transactionReadRepo: any = { findOne: jest.fn(findTxByKey) }
    const walletService: any = {
      findDebitByIdempotencyKey: jest.fn(
        async (walletId: string, key: string) =>
          transactions.find((t) => t.walletId === walletId && t.idempotencyKey === key) ?? null,
      ),
      debit: jest.fn(async (walletId: string, amount: number, meta: any) => {
        const dup = meta?.idempotencyKey
          ? transactions.find((t) => t.idempotencyKey === meta.idempotencyKey)
          : null
        if (dup) return dup
        walletBalances.set(walletId, (walletBalances.get(walletId) ?? 0) - amount)
        const tx = {
          id: `tx-${transactions.length + 1}`,
          walletId,
          amount,
          type: TransactionType.DEBIT,
          status: TransactionStatus.COMPLETED,
          referenceType: meta?.referenceType ?? 'payment',
          referenceId: meta?.referenceId ?? null,
          idempotencyKey: meta?.idempotencyKey ?? null,
        }
        transactions.push(tx)
        return tx
      }),
    }

    // R17: DataSource double serializes pg_advisory_xact_lock calls across QueryRunners.
    const dataSource: any = {
      createQueryRunner: jest.fn(() => {
        let releaseGate: (() => void) | null = null
        const runner: any = {
          isTransactionActive: false,
          isReleased: false,
          connect: jest.fn(async () => undefined),
          startTransaction: jest.fn(async () => void (runner.isTransactionActive = true)),
          query: jest.fn(async (sql: string) => {
            if (sql.includes('pg_advisory_xact_lock')) {
              const prev = advisoryChain
              advisoryChain = new Promise<void>((r) => void (releaseGate = r))
              await prev
            }
            return [{ pg_advisory_xact_lock: '' }]
          }),
          commitTransaction: jest.fn(async () => void (runner.isTransactionActive = false)),
          rollbackTransaction: jest.fn(async () => void (runner.isTransactionActive = false)),
          release: jest.fn(async () => void ((runner.isReleased = true), releaseGate?.())),
        }
        return runner
      }),
      getRepository: jest.fn((entity: any) =>
        entity?.name === 'Subscription' ? subscriptionRepo : { findOne: jest.fn(findTxByKey) },
      ),
    }

    // R17: Collaborator doubles for audit, events, roles, invoices, taxes, and logger.
    const auditService: any = { log: jest.fn(async () => undefined) }
    const eventBus: any = {
      publishPaymentCompleted: jest.fn(),
      notifyPaymentSuccess: jest.fn(),
      notifyInvoiceReady: jest.fn(),
    }
    const clientRoles: any = { assignPlanToBrand: jest.fn(async () => undefined) }
    const invoiceService: any = {
      create: jest.fn(async () => ({ id: 'inv-1', invoiceNumber: 'INV-1' })),
    }
    const taxService: any = {
      getTaxForCountry: jest.fn(async () => ({ taxName: 'IVA', taxRate: 19, isInclusive: true })),
    }
    const log: any = { log: jest.fn(), warn: jest.fn(), error: jest.fn() }

    const seedDebit = (paymentId: string, amount = 49000) =>
      walletService.debit('wallet-1', amount, {
        referenceType: 'payment',
        referenceId: paymentId,
        idempotencyKey: `payment:${paymentId}:debit`,
      })

    const shared = {
      paymentRepo,
      subscriptionRepo,
      subscriptionEventRepo,
      dataSource,
      walletService,
      auditService,
      eventBus,
      clientRoles,
    }
    const checkoutService: CheckoutService = Object.assign(
      Object.create(CheckoutService.prototype),
      shared,
      {
        BILLING_PERIOD_DAYS: 30,
        invoiceService,
        taxService,
        inFlightCheckouts: new Map(),
        inFlightCompletions: new Set(),
        walletReconcileLocks: new Map(),
        log,
      },
    )
    const tasksService: TasksService = Object.assign(
      Object.create(TasksService.prototype),
      shared,
      { CHECKOUT_EXPIRY_HOURS: 24, transactionReadRepo, checkoutService },
    )

    return {
      ...shared,
      payments,
      subscriptions,
      subscriptionEvents,
      transactions,
      walletBalances,
      seedPayment,
      seedDebit,
      invoiceService,
      log,
      checkoutService,
      tasksService,
    }
  }

  it('runs reconcileWalletPayments on its 5-minute cron and completes a debited PENDING payment once', async () => {
    // R15: red if reconcileWalletPayment charges debit without idempotencyKey or lacks @Cron.
    const cronSchedule = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      TasksService.prototype.reconcileWalletPayments,
    )
    expect(cronSchedule?.cronTime).toBe('*/5 * * * *')

    const state = buildState()
    await state.seedDebit('pay-debited-1', 49000)
    state.seedPayment('pay-debited-1', { idempotencyKey: 'idem-debited-1' })

    await state.tasksService.reconcileWalletPayments()

    const updated = state.payments.get('pay-debited-1')!
    expect(updated.status).toBe(PaymentStatus.COMPLETED)
    expect(updated.paidAt).toBeInstanceOf(Date)
    expect(updated.metadata?.checkoutResult).toMatchObject({
      paymentId: 'pay-debited-1',
      status: 'completed',
      subscriptionId: expect.any(String),
    })
    expect(state.clientRoles.assignPlanToBrand).toHaveBeenCalledWith(
      '101',
      'growth',
      expect.any(Date),
    )
    expect(state.walletBalances.get('wallet-1')).toBe(51000)
    expect(state.transactions.filter((t) => t.referenceId === 'pay-debited-1')).toHaveLength(1)
  })

  it('transitions a PENDING wallet payment without debit to failed without touching wallet balance', async () => {
    // R15: red if the non-debited branch skips setting status to FAILED or debits the wallet.
    const state = buildState()
    state.seedPayment('pay-no-debit-1', { brandId: '102', amount: 35000, purposeId: 'starter' })

    await state.tasksService.reconcileWalletPayments()

    expect(state.payments.get('pay-no-debit-1')!.status).toBe(PaymentStatus.FAILED)
    expect(state.walletBalances.get('wallet-1')).toBe(100000)
    expect(state.transactions).toHaveLength(0)
  })

  it('skips in-flight wallet payments younger than the 2-minute cutoff in both branches', async () => {
    // R15: red if isWalletPaymentOldEnoughForReconcile is removed from reconcileWalletPayment.
    const state = buildState()
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000)
    await state.seedDebit('pay-fresh-debited', 20000)
    state.seedPayment('pay-fresh-debited', { createdAt: thirtySecondsAgo })
    state.seedPayment('pay-fresh-nodebit', { createdAt: thirtySecondsAgo })

    const resDebited = await state.checkoutService.reconcileWalletPayment('pay-fresh-debited')
    const resNoDebit = await state.checkoutService.reconcileWalletPayment('pay-fresh-nodebit')

    expect(resDebited.outcome).toBe('noop')
    expect(resNoDebit.outcome).toBe('noop')
    expect(state.payments.get('pay-fresh-debited')!.status).toBe(PaymentStatus.PENDING)
    expect(state.payments.get('pay-fresh-nodebit')!.status).toBe(PaymentStatus.PENDING)
    expect(state.clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
  })

  it('serializes concurrent sweeps on a PROCESSING payment so post-debit effects run only once', async () => {
    // R15: red if acquireWalletReconcileLock is bypassed, duplicating event, role, and audit calls.
    const state = buildState()
    const initialEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
    state.subscriptions.set('sub-existing', {
      id: 'sub-existing',
      brandId: '105',
      planSlug: 'growth',
      status: SubscriptionStatus.ACTIVE,
      provider: SubscriptionProvider.WALLET,
      walletId: 'wallet-1',
      currentPeriodStart: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: initialEnd,
      nextBillingDate: initialEnd,
      lastPaymentId: 'previous-payment',
      retryCount: 0,
      autoRenew: true,
    })
    await state.seedDebit('pay-processing-race', 49000)
    state.seedPayment('pay-processing-race', {
      brandId: '105',
      status: PaymentStatus.PROCESSING,
    })

    await Promise.all([
      state.checkoutService.reconcileWalletPayment('pay-processing-race'),
      state.checkoutService.reconcileWalletPayment('pay-processing-race'),
    ])

    const events = state.subscriptionEvents.filter((e) => e.paymentId === 'pay-processing-race')
    expect(events).toHaveLength(1)
    expect(state.clientRoles.assignPlanToBrand).toHaveBeenCalledTimes(1)
    expect(state.auditService.log).toHaveBeenCalledTimes(1)
    expect(state.payments.get('pay-processing-race')!.status).toBe(PaymentStatus.COMPLETED)
  })

  it('keeps the payment in PROCESSING when auditService.log fails and completes on the next sweep', async () => {
    // R15: red if reconcileWalletPayment marks COMPLETED when auditService.log throws.
    const state = buildState()
    await state.seedDebit('pay-retry-effect', 49000)
    state.seedPayment('pay-retry-effect', { idempotencyKey: 'idem-retry-effect' })
    state.auditService.log.mockRejectedValueOnce(new Error('Audit write failed'))

    await expect(state.checkoutService.reconcileWalletPayment('pay-retry-effect')).rejects.toThrow(
      'Audit write failed',
    )
    expect(state.payments.get('pay-retry-effect')!.status).toBe(PaymentStatus.PROCESSING)

    await state.checkoutService.reconcileWalletPayment('pay-retry-effect')
    const completed = state.payments.get('pay-retry-effect')!
    expect(completed.status).toBe(PaymentStatus.COMPLETED)
    expect(completed.metadata?.checkoutResult).toMatchObject({
      paymentId: 'pay-retry-effect',
      status: 'completed',
    })
  })

  it('does not overwrite an active subscription on another plan and leaves old payment in PROCESSING', async () => {
    // R15: red if findConflictingActivePlanSubscription is bypassed and overwrites planSlug.
    const state = buildState()
    await state.seedDebit('pay-old-plan', 49000)
    state.seedPayment('pay-old-plan', { brandId: '106', purposeId: 'dropi-roax' })
    state.subscriptions.set('sub-newer', {
      id: 'sub-newer',
      brandId: '106',
      planSlug: 'growth',
      status: SubscriptionStatus.ACTIVE,
      provider: SubscriptionProvider.WALLET,
      lastPaymentId: 'pay-newer-plan',
    })

    await state.tasksService.reconcileWalletPayments()

    expect(state.subscriptions.get('sub-newer')!.planSlug).toBe('growth')
    expect(state.subscriptions.get('sub-newer')!.lastPaymentId).toBe('pay-newer-plan')
    expect(state.payments.get('pay-old-plan')!.status).toBe(PaymentStatus.PROCESSING)
    expect(state.clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
    expect(state.log.error).toHaveBeenCalledTimes(1)
  })

  it('prevents reconcilePayment and completeExternalPayment from invoicing a wallet payment', async () => {
    // R15: red if reconcilePayment or completeExternalPayment lets WALLET call invoiceService.
    const state = buildState()
    state.seedPayment('pay-wallet-proc', { status: PaymentStatus.PROCESSING })

    const reconcileRes = await state.checkoutService.reconcilePayment('pay-wallet-proc')
    await state.checkoutService.completeExternalPayment('pay-wallet-proc')

    expect(reconcileRes).toEqual({ status: PaymentStatus.PROCESSING })
    expect(state.invoiceService.create).not.toHaveBeenCalled()
    expect(state.payments.get('pay-wallet-proc')!.status).toBe(PaymentStatus.PROCESSING)
  })

  it('does not expire a PENDING payment with a wallet debit while expiring unpaid PENDING rows', async () => {
    // R15: red if expirePendingCheckouts updates PENDING rows without excluding debited ones.
    const state = buildState()
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await state.seedDebit('pay-old-debited', 49000)
    state.seedPayment('pay-old-debited', { createdAt: twoDaysAgo })
    state.seedPayment('pay-old-unpaid', { createdAt: twoDaysAgo })

    await state.tasksService.expirePendingCheckouts()

    expect(state.payments.get('pay-old-debited')!.status).toBe(PaymentStatus.PENDING)
    expect(state.payments.get('pay-old-unpaid')!.status).toBe(PaymentStatus.FAILED)
  })
})
