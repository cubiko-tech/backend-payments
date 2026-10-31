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

    const seedSub = (id: string, brandId: string, planSlug: string, extra: any = {}) => {
      const sub = {
        id,
        brandId,
        planSlug,
        status: SubscriptionStatus.ACTIVE,
        provider: SubscriptionProvider.WALLET,
        currentPeriodEnd: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
        lastPaymentId: null,
        autoRenew: true,
        ...extra,
      }
      subscriptions.set(id, sub)
      return sub
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
      save: jest.fn(async (entity: any) => (payments.set(entity.id, { ...entity }), entity)),
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
    const walletService: any = {
      findDebitByIdempotencyKey: jest.fn(
        async (walletId: string, key: string) =>
          transactions.find((t) => t.walletId === walletId && t.idempotencyKey === key) ?? null,
      ),
      debit: jest.fn(async (walletId: string, amount: number, meta: any) => {
        const dup = transactions.find(
          (t) => t.idempotencyKey && t.idempotencyKey === meta?.idempotencyKey,
        )
        if (dup) return dup
        walletBalances.set(walletId, (walletBalances.get(walletId) ?? 0) - amount)
        const tx = {
          id: `tx-${transactions.length + 1}`,
          walletId,
          amount,
          type: TransactionType.DEBIT,
          status: TransactionStatus.COMPLETED,
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
        return {
          connect: jest.fn(),
          startTransaction: jest.fn(),
          query: jest.fn(async (sql: string) => {
            if (sql.includes('pg_advisory_xact_lock')) {
              const prev = advisoryChain
              advisoryChain = new Promise<void>((r) => void (releaseGate = r))
              await prev
            }
            return [{ pg_advisory_xact_lock: '' }]
          }),
          commitTransaction: jest.fn(),
          rollbackTransaction: jest.fn(),
          release: jest.fn(async () => releaseGate?.()),
        }
      }),
      getRepository: jest.fn((entity: any) =>
        entity?.name === 'Subscription' ? subscriptionRepo : { findOne: jest.fn(findTxByKey) },
      ),
    }

    const seedDebit = (paymentId: string, amount = 49000) =>
      walletService.debit('wallet-1', amount, {
        referenceId: paymentId,
        idempotencyKey: `payment:${paymentId}:debit`,
      })

    // R17: Collaborator doubles for audit, events, roles, invoices, taxes, and logger.
    const state: any = Object.assign(
      {
        BILLING_PERIOD_DAYS: 30,
        CHECKOUT_EXPIRY_HOURS: 24,
        transactionReadRepo: { findOne: jest.fn(findTxByKey) },
        auditService: { log: jest.fn(async () => undefined) },
        eventBus: {
          publishPaymentCompleted: jest.fn(),
          notifyPaymentSuccess: jest.fn(),
          notifyInvoiceReady: jest.fn(),
        },
        clientRoles: { assignPlanToBrand: jest.fn(async () => undefined) },
        invoiceService: { create: jest.fn(async () => ({ id: 'inv-1', invoiceNumber: 'INV-1' })) },
        taxService: {
          getTaxForCountry: jest.fn(async () => ({
            taxName: 'IVA',
            taxRate: 19,
            isInclusive: true,
          })),
        },
        log: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      },
      { paymentRepo, subscriptionRepo, subscriptionEventRepo, dataSource, walletService },
      { payments, subscriptions, subscriptionEvents, transactions, walletBalances },
      { seedPayment, seedSub, seedDebit },
    )
    const makeCheckout = (): CheckoutService =>
      Object.assign(Object.create(CheckoutService.prototype), state, {
        inFlightCheckouts: new Map(),
        inFlightCompletions: new Set(),
        walletReconcileLocks: new Map(),
      })
    state.checkoutService = makeCheckout()
    state.checkoutServiceB = makeCheckout()
    state.tasksService = Object.assign(Object.create(TasksService.prototype), state)
    return state
  }

  it('runs reconcileWalletPayments on its 5-minute cron and completes a debited PENDING payment once', async () => {
    // R15: red if reconcileWalletPayment charges debit without idempotencyKey or lacks @Cron.
    const cron = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      TasksService.prototype.reconcileWalletPayments,
    )
    expect(cron?.cronTime).toBe('*/5 * * * *')

    const s = buildState()
    await s.seedDebit('pay-debited-1', 49000)
    s.seedPayment('pay-debited-1', { idempotencyKey: 'idem-debited-1' })

    await s.tasksService.reconcileWalletPayments()

    const updated = s.payments.get('pay-debited-1')!
    expect(updated.status).toBe(PaymentStatus.COMPLETED)
    expect(updated.paidAt).toBeInstanceOf(Date)
    expect(updated.metadata?.checkoutResult).toMatchObject({
      paymentId: 'pay-debited-1',
      status: 'completed',
      subscriptionId: expect.any(String),
    })
    expect(s.clientRoles.assignPlanToBrand).toHaveBeenCalledWith('101', 'growth', expect.any(Date))
    expect(s.walletBalances.get('wallet-1')).toBe(51000)
    expect(s.transactions.filter((t: any) => t.referenceId === 'pay-debited-1')).toHaveLength(1)
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
    // R15: red if pg_advisory_xact_lock is removed, duplicating event, role, and audit calls.
    const state = buildState()
    state.seedSub('sub-existing', '105', 'growth', { lastPaymentId: 'previous-payment' })
    await state.seedDebit('pay-processing-race', 49000)
    state.seedPayment('pay-processing-race', { brandId: '105', status: PaymentStatus.PROCESSING })

    await Promise.all([
      state.checkoutService.reconcileWalletPayment('pay-processing-race'),
      state.checkoutServiceB.reconcileWalletPayment('pay-processing-race'),
    ])

    const events = state.subscriptionEvents.filter(
      (e: any) => e.paymentId === 'pay-processing-race',
    )
    expect(events).toHaveLength(1)
    expect(state.clientRoles.assignPlanToBrand).toHaveBeenCalledTimes(1)
    expect(state.auditService.log).toHaveBeenCalledTimes(1)
    expect(state.payments.get('pay-processing-race')!.status).toBe(PaymentStatus.COMPLETED)
  })

  it('keeps the payment in PROCESSING when createOrRenewSubscription fails and completes on retry', async () => {
    // R15: red if reconcileWalletPayment marks COMPLETED when createOrRenewSubscription throws.
    const { seedDebit, seedPayment, subscriptionRepo, checkoutService, payments } = buildState()
    await seedDebit('pay-retry-effect', 49000)
    seedPayment('pay-retry-effect', { idempotencyKey: 'idem-retry-effect' })
    subscriptionRepo.save.mockRejectedValueOnce(new Error('Subscription write failed'))

    const firstAttempt = checkoutService.reconcileWalletPayment('pay-retry-effect')
    await expect(firstAttempt).rejects.toThrow('Subscription write failed')
    expect(payments.get('pay-retry-effect')!.status).toBe(PaymentStatus.PROCESSING)

    await checkoutService.reconcileWalletPayment('pay-retry-effect')
    const completed = payments.get('pay-retry-effect')!
    expect(completed.status).toBe(PaymentStatus.COMPLETED)
    expect(completed.metadata?.checkoutResult).toMatchObject({
      paymentId: 'pay-retry-effect',
      status: 'completed',
    })
  })

  it('completes a plan change when subscription has no lastPaymentId or an older lastPaymentId', async () => {
    // R15: red if findConflictingPlanSubscription blocks null or older lastPaymentId.
    const state = buildState()
    const tPrior = new Date(Date.now() - 30 * 60 * 1000)
    const tUpgrade = new Date(Date.now() - 10 * 60 * 1000)
    state.seedSub('sub-no-pay', '107', 'starter', { lastPaymentId: null })
    await state.seedDebit('pay-upgrade-null', 49000)
    state.seedPayment('pay-upgrade-null', { brandId: '107', createdAt: tUpgrade })

    state.seedPayment('pay-prior', {
      brandId: '108',
      purposeId: 'starter',
      status: PaymentStatus.COMPLETED,
      createdAt: tPrior,
      paidAt: tPrior,
    })
    state.seedSub('sub-older-pay', '108', 'starter', { lastPaymentId: 'pay-prior' })
    await state.seedDebit('pay-upgrade-older', 49000)
    state.seedPayment('pay-upgrade-older', { brandId: '108', createdAt: tUpgrade })

    await state.tasksService.reconcileWalletPayments()
    expect(state.payments.get('pay-upgrade-null')!.status).toBe(PaymentStatus.COMPLETED)
    expect(state.subscriptions.get('sub-no-pay')!.planSlug).toBe('growth')
    expect(state.subscriptions.get('sub-no-pay')!.lastPaymentId).toBe('pay-upgrade-null')
    expect(state.payments.get('pay-upgrade-older')!.status).toBe(PaymentStatus.COMPLETED)
    expect(state.subscriptions.get('sub-older-pay')!.planSlug).toBe('growth')
    expect(state.subscriptions.get('sub-older-pay')!.lastPaymentId).toBe('pay-upgrade-older')
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
