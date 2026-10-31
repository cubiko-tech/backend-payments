import { CheckoutService } from '../checkout/checkout.service'
import { getWalletRefundIdempotencyKey } from '../checkout/wallet-payment-reconciliation'
import { PaymentProvider, PaymentPurpose, PaymentStatus } from '../payment/entities/payment.entity'
import {
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { TransactionStatus, TransactionType } from '../transaction/entities/transaction.entity'
import { TasksService } from './tasks.service'

const beforeDate = (val: any, cutoff: any) =>
  !(cutoff instanceof Date) || new Date(val).getTime() < cutoff.getTime()

// R17: in-memory Payment, Subscription, and SubscriptionEvent repo doubles for unit reconciliation tests.
function createRepoDoubles(
  payments: Map<string, any>,
  subscriptions: Map<string, any>,
  subscriptionEvents: any[],
  callOrder: string[],
) {
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
      callOrder.push(`payment.update:${partial?.status ?? 'other'}`)
      const ids = [criteria?.id?._value ?? criteria?.id ?? Array.from(payments.keys())].flat()
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
  const subscriptionRepo: any = {
    findOne: jest.fn(async ({ where }: any = {}) => {
      const sub = Array.from(subscriptions.values()).find(
        (s) => s.brandId === where?.brandId || s.id === where?.id,
      )
      return sub ? { ...sub } : null
    }),
    create: jest.fn((data: any) => ({ id: `sub-${subscriptions.size + 1}`, ...data })),
    save: jest.fn(async (sub: any) => (subscriptions.set(sub.id, { ...sub }), sub)),
  }
  const subscriptionEventRepo: any = {
    findOne: jest.fn(
      async ({ where }: any = {}) =>
        subscriptionEvents.find((e) => e.paymentId === where?.paymentId) ?? null,
    ),
    create: jest.fn((data: any) => ({ id: `evt-${subscriptionEvents.length + 1}`, ...data })),
    save: jest.fn(async (evt: any) => (subscriptionEvents.push(evt), evt)),
  }
  return { paymentRepo, subscriptionRepo, subscriptionEventRepo }
}

// R17: WalletService and DataSource doubles track debits, idempotent credits, and advisory locks.
function createWalletAndDataSourceDoubles(
  transactions: any[],
  walletBalances: Map<string, number>,
  subscriptionRepo: any,
  callOrder: string[],
) {
  let advisoryChain = Promise.resolve()
  const findTxByKey = async ({ where }: any = {}) =>
    transactions.find((t) => t.idempotencyKey === where?.idempotencyKey) ?? null
  const walletService: any = {
    findDebitByIdempotencyKey: jest.fn(
      async (walletId: string, key: string) =>
        transactions.find((t) => t.walletId === walletId && t.idempotencyKey === key) ?? null,
    ),
    debit: jest.fn(async (walletId: string, amount: number, meta: any) => {
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
      return { data: { transaction: tx } }
    }),
    credit: jest.fn(async (walletId: string, amount: number, meta: any) => {
      callOrder.push('wallet.credit')
      const resolvedKey = meta?.idempotencyKey ?? null
      const dup = resolvedKey
        ? transactions.find((t) => t.idempotencyKey === resolvedKey)
        : undefined
      if (dup) {
        return {
          data: {
            wallet: { id: walletId, balance: walletBalances.get(walletId) ?? 0 },
            transaction: dup,
          },
        }
      }
      const balanceBefore = walletBalances.get(walletId) ?? 0
      const balanceAfter = balanceBefore + amount
      walletBalances.set(walletId, balanceAfter)
      const tx = {
        id: `tx-${transactions.length + 1}`,
        walletId,
        brandId: meta?.brandId ?? '106',
        amount,
        balanceBefore,
        balanceAfter,
        type: TransactionType.CREDIT,
        status: TransactionStatus.COMPLETED,
        category: meta?.category ?? null,
        description: meta?.description ?? null,
        referenceType: meta?.referenceType ?? null,
        referenceId: meta?.referenceId ?? null,
        idempotencyKey: resolvedKey,
      }
      transactions.push(tx)
      return { data: { wallet: { id: walletId, balance: balanceAfter }, transaction: tx } }
    }),
  }
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
  return { walletService, dataSource, findTxByKey }
}

describe('Superseded wallet payment refund during reconciliation (LOC-96)', () => {
  const buildState = () => {
    const payments = new Map<string, any>()
    const subscriptions = new Map<string, any>()
    const subscriptionEvents: any[] = []
    const transactions: any[] = []
    const walletBalances = new Map<string, number>([['wallet-1', 100000]])
    const callOrder: string[] = []
    const repos = createRepoDoubles(payments, subscriptions, subscriptionEvents, callOrder)
    const { walletService, dataSource, findTxByKey } = createWalletAndDataSourceDoubles(
      transactions,
      walletBalances,
      repos.subscriptionRepo,
      callOrder,
    )
    const seedPayment = (id: string, overrides: Record<string, any> = {}) => {
      const row = {
        id,
        brandId: '106',
        userId: 'user-1',
        walletId: 'wallet-1',
        amount: 49000,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        provider: PaymentProvider.WALLET,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: 'dropi-roax',
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
    const seedDebit = (paymentId: string, amount = 49000) =>
      walletService.debit('wallet-1', amount, {
        referenceId: paymentId,
        idempotencyKey: `payment:${paymentId}:debit`,
      })

    // R17: Collaborator doubles for audit, events, roles, and logger.
    const state: any = Object.assign(
      {
        BILLING_PERIOD_DAYS: 30,
        CHECKOUT_EXPIRY_HOURS: 24,
        transactionReadRepo: { findOne: jest.fn(findTxByKey) },
        auditService: {
          log: jest.fn(
            async (_u: string, action: string) => void callOrder.push(`audit.log:${action}`),
          ),
        },
        eventBus: {
          publishPaymentCompleted: jest.fn(),
          notifyPaymentSuccess: jest.fn(),
          notifyInvoiceReady: jest.fn(),
        },
        clientRoles: { assignPlanToBrand: jest.fn(async () => undefined) },
        log: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      },
      repos,
      { dataSource, walletService, payments, subscriptions, subscriptionEvents, transactions },
      { walletBalances, callOrder, seedPayment, seedSub, seedDebit },
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

  const seedConflictingScenario = async (state: any, paymentId: string, extraPayment: any = {}) => {
    const tOld = new Date(Date.now() - 10 * 60 * 1000)
    const tNewer = new Date(Date.now() - 5 * 60 * 1000)
    await state.seedDebit(paymentId, 49000)
    state.seedPayment(paymentId, {
      brandId: '106',
      purposeId: 'dropi-roax',
      createdAt: tOld,
      ...extraPayment,
    })
    state.seedPayment('pay-newer-plan', {
      brandId: '106',
      purposeId: 'growth',
      status: PaymentStatus.COMPLETED,
      createdAt: tNewer,
      paidAt: tNewer,
    })
    state.seedSub('sub-newer', '106', 'growth', { lastPaymentId: 'pay-newer-plan' })
  }

  it('refunds a debited wallet payment when subscription is on another plan from a newer payment', async () => {
    // R15: red if refundSupersededWalletPayment skips crediting the wallet or marking REFUNDED.
    const state = buildState()
    await seedConflictingScenario(state, 'pay-old-plan', { idempotencyKey: 'idem-old-plan' })

    await state.tasksService.reconcileWalletPayments()

    const refunded = state.payments.get('pay-old-plan')!
    expect(refunded.status).toBe(PaymentStatus.REFUNDED)
    expect(refunded.metadata?.checkoutResult).toBeUndefined()
    expect(state.walletBalances.get('wallet-1')).toBe(100000)
    expect(state.subscriptions.get('sub-newer')!.planSlug).toBe('growth')
    expect(state.subscriptions.get('sub-newer')!.lastPaymentId).toBe('pay-newer-plan')
    expect(state.clientRoles.assignPlanToBrand).not.toHaveBeenCalled()
    expect(state.eventBus.publishPaymentCompleted).not.toHaveBeenCalled()
  })

  it('records the credit transaction and audit trail before updating the payment to refunded', async () => {
    // R15: red if auditService.log or transaction reference metadata is omitted or runs after update.
    const state = buildState()
    await seedConflictingScenario(state, 'pay-trace')

    const res = await state.checkoutService.reconcileWalletPayment('pay-trace')
    expect(res).toEqual({ outcome: 'refunded', status: PaymentStatus.REFUNDED })

    const creditTx = state.transactions.find((t: any) => t.type === TransactionType.CREDIT)
    expect(creditTx).toMatchObject({
      walletId: 'wallet-1',
      amount: 49000,
      category: 'refund',
      referenceType: 'payment',
      referenceId: 'pay-trace',
    })
    expect(state.auditService.log).toHaveBeenCalledWith(
      'user-1',
      'wallet_payment_refunded',
      'payment',
      'pay-trace',
      expect.objectContaining({
        planSlug: 'dropi-roax',
        conflictingPlanSlug: 'growth',
        conflictingPaymentId: 'pay-newer-plan',
        amount: 49000,
        walletId: 'wallet-1',
        idempotencyKey: 'payment:pay-trace:refund',
      }),
      expect.stringContaining('newer plan growth'),
    )
    expect(state.callOrder).toEqual([
      'payment.update:processing',
      'wallet.credit',
      'audit.log:wallet_payment_refunded',
      'payment.update:refunded',
    ])
  })

  it('credits once when a retry follows a failed status update or two sweeps run concurrently', async () => {
    // R15: red if getWalletRefundIdempotencyKey is not passed to walletService.credit.
    const state = buildState()
    await seedConflictingScenario(state, 'pay-idem-refund', { status: PaymentStatus.PROCESSING })

    const origUpdate = state.paymentRepo.update
    // R17: Simulate a failed status update to REFUNDED on the first sweep so the next sweep retries.
    state.paymentRepo.update = jest.fn(async (criteria: any, partial: any) => {
      if (partial?.status === PaymentStatus.REFUNDED) {
        state.paymentRepo.update = origUpdate
        return { affected: 0 }
      }
      return origUpdate(criteria, partial)
    })

    const first = await state.checkoutService.reconcileWalletPayment('pay-idem-refund')
    expect(first).toEqual({ outcome: 'noop', status: PaymentStatus.PROCESSING })
    expect(state.walletBalances.get('wallet-1')).toBe(100000)

    await Promise.all([
      state.checkoutService.reconcileWalletPayment('pay-idem-refund'),
      state.checkoutServiceB.reconcileWalletPayment('pay-idem-refund'),
    ])

    const credits = state.transactions.filter((t: any) => t.type === TransactionType.CREDIT)
    expect(credits).toHaveLength(1)
    expect(credits[0].idempotencyKey).toBe(getWalletRefundIdempotencyKey('pay-idem-refund'))
    expect(state.walletBalances.get('wallet-1')).toBe(100000)
    expect(state.payments.get('pay-idem-refund')!.status).toBe(PaymentStatus.REFUNDED)
  })

  it('keeps the payment in PROCESSING and logs an error when credit fails, then refunds on retry', async () => {
    // R15: red if a credit error transitions the payment out of PROCESSING or swallows logger.error.
    const state = buildState()
    await seedConflictingScenario(state, 'pay-credit-fail')

    state.walletService.credit
      .mockRejectedValueOnce(new Error('DB connection lost'))
      .mockResolvedValueOnce({ error: 'Wallet locked' })

    await state.tasksService.reconcileWalletPayments()
    expect(state.payments.get('pay-credit-fail')!.status).toBe(PaymentStatus.PROCESSING)
    expect(state.walletBalances.get('wallet-1')).toBe(51000)
    expect(state.log.error).toHaveBeenCalledTimes(1)

    await state.tasksService.reconcileWalletPayments()
    expect(state.payments.get('pay-credit-fail')!.status).toBe(PaymentStatus.PROCESSING)
    expect(state.walletBalances.get('wallet-1')).toBe(51000)
    expect(state.log.error).toHaveBeenCalledTimes(2)

    await state.tasksService.reconcileWalletPayments()
    expect(state.payments.get('pay-credit-fail')!.status).toBe(PaymentStatus.REFUNDED)
    expect(state.walletBalances.get('wallet-1')).toBe(100000)
  })

  it('completes a debited wallet payment when there is no newer conflicting plan purchase', async () => {
    // R15: red if reconcileWalletPayment refunds a payment when no newer plan purchase exists.
    const state = buildState()
    await state.seedDebit('pay-normal-complete', 49000)
    state.seedPayment('pay-normal-complete', { brandId: '109', purposeId: 'growth' })

    await state.tasksService.reconcileWalletPayments()

    expect(state.payments.get('pay-normal-complete')!.status).toBe(PaymentStatus.COMPLETED)
    expect(state.walletBalances.get('wallet-1')).toBe(51000)
    expect(state.walletService.credit).not.toHaveBeenCalled()
    expect(state.clientRoles.assignPlanToBrand).toHaveBeenCalledWith(
      '109',
      'growth',
      expect.any(Date),
    )
  })
})
