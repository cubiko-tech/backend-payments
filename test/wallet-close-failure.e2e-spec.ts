import { Payment, PaymentStatus } from '../src/payment/entities/payment.entity'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  backdate,
  balanceOf,
  cleanBrand,
  createGate,
  findPaymentByKey,
  movements,
  parkFirstCall,
  planCheckout,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
  sweepAfter,
} from './support/wallet-race.fixture'
import { scopeSweepsToBrand } from './support/brand-scoped-sweep'

const BRAND_ID = 'a7990001-2222-4333-8444-555555555555'
const BALANCE = 100000
const SERVICE_PRICE = 10000
const CLOSE_ERROR = 'Subscription save failed'
const DAY_MS = 24 * 60 * 60 * 1000
const TEN_MINUTES_MS = 10 * 60 * 1000
const TWO_HOURS_MS = 2 * 60 * 60 * 1000
const IN_PROGRESS = { response: { code: 'IDEMPOTENT_CHECKOUT_IN_PROGRESS' } }

describe('A wallet close that fails after the debit (PostgreSQL, LOC-99)', () => {
  let a: RaceInstance
  let b: RaceInstance

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
    scopeSweepsToBrand(a.tasks, BRAND_ID)
    scopeSweepsToBrand(b.tasks, BRAND_ID)
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND_ID))

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
    await stopInstance(b)
  })

  const buyPlan = (walletId: string, key: string) =>
    a.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, 'dropi-roax'))

  const buyService = (walletId: string, key: string) =>
    a.checkout.processCheckout({
      brandId: BRAND_ID,
      userId: 'user-loc99',
      provider: 'wallet',
      purpose: 'service_payment',
      amount: SERVICE_PRICE,
      currency: 'COP',
      walletId,
      idempotencyKey: key,
    })

  // R17: A rejected save is a database failure that cannot be provoked on demand otherwise.
  const failSubscriptionSave = (instance: RaceInstance) =>
    jest
      .spyOn(instance.checkout as any, 'createOrRenewSubscription')
      .mockRejectedValue(new Error(CLOSE_ERROR))

  // R17: Fails the whole close, for the purchases that never save a subscription.
  const failClose = (instance: RaceInstance) =>
    jest
      .spyOn(instance.checkout as any, 'closeWalletPayment')
      .mockRejectedValue(new Error(CLOSE_ERROR))

  /** A debited plan purchase whose checkout failed to close, left to the sweep. */
  const buyPlanWithFailedClose = async (walletId: string, key: string) => {
    const spy = failSubscriptionSave(a)
    await expect(buyPlan(walletId, key)).rejects.toThrow(CLOSE_ERROR)
    spy.mockRestore()
    return findPaymentByKey(a.dataSource, key)
  }

  const buyServiceWithFailedClose = async (walletId: string, key: string) => {
    const spy = failClose(a)
    await expect(buyService(walletId, key)).rejects.toThrow(CLOSE_ERROR)
    spy.mockRestore()
    return findPaymentByKey(a.dataSource, key)
  }

  const sweepAged = async (paymentId: string, interval: string) => {
    await backdate(a.dataSource, paymentId, interval)
    await b.tasks.reconcileWalletPayments()
  }

  const debitsOf = (paymentId: string) => movements(a.dataSource, paymentId, TransactionType.DEBIT)

  const creditsOf = (paymentId: string) =>
    movements(a.dataSource, paymentId, TransactionType.CREDIT)

  const subscription = () =>
    a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID })

  // R17: The credit commits and only the status write fails, the gap a refund has to survive.
  const failRefundedWriteOnce = () => {
    const repo = b.dataSource.getRepository(Payment)
    const realUpdate = repo.update.bind(repo)
    let failed = false
    return jest.spyOn(repo, 'update').mockImplementation(async (criteria: any, partial: any) => {
      if (partial?.status === PaymentStatus.REFUNDED && !failed) {
        failed = true
        throw new Error('Refunded write failed')
      }
      return realUpdate(criteria, partial)
    })
  }

  it('E1: the sweep finishes a failed close with the plan and its days', async () => {
    // R15: red if the catch writes completed again: the payment ends completed without a plan.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await buyPlanWithFailedClose(wallet.id, 'loc99-e1')

    expect(payment.status).toBe(PaymentStatus.PROCESSING)
    expect(payment.paidAt).toBeNull()
    expect(await debitsOf(payment.id)).toHaveLength(1)
    expect(await subscription()).toBeNull()

    await sweepAged(payment.id, '10 minutes')

    const closed = await findPaymentByKey(a.dataSource, 'loc99-e1')
    expect(closed.status).toBe(PaymentStatus.COMPLETED)
    expect(closed.metadata?.checkoutResult).toMatchObject({ status: 'completed' })
    const sub = (await subscription())!
    expect(sub.lastPaymentId).toBe(payment.id)
    const days = (new Date(sub.currentPeriodEnd).getTime() - Date.now()) / DAY_MS
    expect(Math.round(days)).toBe(30)
    expect(await debitsOf(payment.id)).toHaveLength(1)
    expect(await creditsOf(payment.id)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('E2: a close that keeps failing stays swept for an hour and then credits the debit', async () => {
    // R15: red if the sweep always rethrows: the payment never leaves processing.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await buyPlanWithFailedClose(wallet.id, 'loc99-e2')
    failSubscriptionSave(b)

    await expect(sweepAfter(b, payment.id, TEN_MINUTES_MS)).rejects.toThrow(CLOSE_ERROR)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PROCESSING)
    expect(await creditsOf(payment.id)).toHaveLength(0)

    await sweepAfter(b, payment.id, TWO_HOURS_MS)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await debitsOf(payment.id)).toHaveLength(1)
    expect(await creditsOf(payment.id)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
    expect(await subscription()).toBeNull()

    expect(await buyPlan(wallet.id, 'loc99-e2')).toMatchObject({ status: 'refunded' })
    expect(await debitsOf(payment.id)).toHaveLength(1)
  })

  it('E2b: giving up does not credit a payment whose failed commit did close it', async () => {
    // R15: red if the give-up skips the re-read: the completed payment also gets its credit.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await buyServiceWithFailedClose(wallet.id, 'loc99-e2b')
    const realClose = (b.checkout as any).closeWalletPayment.bind(b.checkout)
    // R17: A commit that lands and still reports an error cannot be provoked on demand.
    jest.spyOn(b.checkout as any, 'closeWalletPayment').mockImplementation(async (...args) => {
      await realClose(...args)
      throw new Error('Connection lost after the commit')
    })

    await expect(sweepAfter(b, payment.id, TWO_HOURS_MS)).rejects.toThrow('Connection lost')

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(payment.id)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - SERVICE_PRICE)
  })

  it('E2c: giving up does not credit a purchase handed back with its plan applied', async () => {
    // R15: red if the give-up skips isPlanAppliedByPayment: the applied purchase gets a credit.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buyPlan(wallet.id, 'loc99-e2c')
    const payment = await findPaymentByKey(a.dataSource, 'loc99-e2c')
    await a.dataSource
      .getRepository(Payment)
      .update(payment.id, { status: PaymentStatus.PROCESSING })
    failClose(b)

    await expect(sweepAfter(b, payment.id, TWO_HOURS_MS)).rejects.toThrow(CLOSE_ERROR)

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PROCESSING)
    expect(await creditsOf(payment.id)).toHaveLength(0)
  })

  it('E3: the sweep finishes a plan refund whose status write failed without a second credit', async () => {
    // R15: red if the sweep skips hasWalletPaymentRefund: it closes with the money back.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await buyPlanWithFailedClose(wallet.id, 'loc99-e3-plan')
    jest
      .spyOn(b.checkout as any, 'createOrRenewSubscription')
      .mockRejectedValueOnce(new Error(CLOSE_ERROR))
    failRefundedWriteOnce()

    await expect(sweepAfter(b, payment.id, TWO_HOURS_MS)).rejects.toThrow('Refunded write failed')
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await creditsOf(payment.id)).toHaveLength(1)

    await sweepAfter(b, payment.id, TWO_HOURS_MS)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(payment.id)).toHaveLength(1)
    expect(await subscription()).toBeNull()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('E3: the sweep finishes a service refund whose status write failed without closing it', async () => {
    // R15: red if the refund check goes back to plan purchases only: it ends completed with a credit.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await buyServiceWithFailedClose(wallet.id, 'loc99-e3-service')
    jest
      .spyOn(b.checkout as any, 'closeWalletPayment')
      .mockRejectedValueOnce(new Error(CLOSE_ERROR))
    failRefundedWriteOnce()

    await expect(sweepAfter(b, payment.id, TWO_HOURS_MS)).rejects.toThrow('Refunded write failed')
    expect(await creditsOf(payment.id)).toHaveLength(1)

    await sweepAfter(b, payment.id, TWO_HOURS_MS)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(payment.id)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('E4: an audit failure after the close keeps the payment completed with its plan', async () => {
    // R15: red if a failure in the audit step moves the payment back to processing.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    // R17: The audit table has no way to fail on demand.
    jest
      .spyOn((a.checkout as any).auditService, 'log')
      .mockRejectedValueOnce(new Error('Audit down'))

    await expect(buyPlan(wallet.id, 'loc99-e4-audit')).rejects.toThrow('Audit down')

    const payment = await findPaymentByKey(a.dataSource, 'loc99-e4-audit')
    expect(payment.status).toBe(PaymentStatus.COMPLETED)
    expect((await subscription())?.lastPaymentId).toBe(payment.id)
    await sweepAged(payment.id, '2 hours')
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(payment.id)).toHaveLength(0)
    await expect(buyPlan(wallet.id, 'loc99-e4-audit')).rejects.toMatchObject({
      response: { code: 'IDEMPOTENT_CHECKOUT_INCOMPLETE', paymentId: payment.id },
    })
    expect(await debitsOf(payment.id)).toHaveLength(1)
  })

  it('E4: roles rejecting the plan after the close keeps the payment completed with its plan', async () => {
    // R15: red if a false from roles starts throwing: the purchase rejects after its close.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    // R17: The roles client answers false on any failure, so the double does too, never rejects.
    a.assignPlan.mockResolvedValueOnce(false)

    await expect(buyPlan(wallet.id, 'loc99-e4-roles')).resolves.toMatchObject({
      status: 'completed',
    })

    const payment = await findPaymentByKey(a.dataSource, 'loc99-e4-roles')
    expect(payment.status).toBe(PaymentStatus.COMPLETED)
    expect((await subscription())?.lastPaymentId).toBe(payment.id)
    expect(await debitsOf(payment.id)).toHaveLength(1)
  })

  it('E4: a failed read after the close keeps the payment completed with its plan', async () => {
    // R15: red if a failure reading the subscription moves the payment back to processing.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    // R17: The close commits on its own connection; only this later read has to fail.
    jest
      .spyOn(a.dataSource.getRepository(Subscription), 'findOne')
      .mockRejectedValueOnce(new Error('Read failed'))

    await expect(buyPlan(wallet.id, 'loc99-e4-read')).rejects.toThrow('Read failed')

    const payment = await findPaymentByKey(a.dataSource, 'loc99-e4-read')
    expect(payment.status).toBe(PaymentStatus.COMPLETED)
    expect((await subscription())?.lastPaymentId).toBe(payment.id)
    await sweepAged(payment.id, '2 hours')
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await debitsOf(payment.id)).toHaveLength(1)
  })

  it('E5: a retry while the sweep owns the payment says in progress and does not debit', async () => {
    // R15: red if the wallet + processing replay branch goes: the retry answers processing with 201.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await buyPlanWithFailedClose(wallet.id, 'loc99-e5')

    await expect(buyPlan(wallet.id, 'loc99-e5')).rejects.toMatchObject({
      response: { ...IN_PROGRESS.response, paymentId: payment.id },
    })
    expect(await debitsOf(payment.id)).toHaveLength(1)

    await sweepAged(payment.id, '10 minutes')
    expect(await buyPlan(wallet.id, 'loc99-e5')).toMatchObject({
      paymentId: payment.id,
      status: 'completed',
    })
    expect(await debitsOf(payment.id)).toHaveLength(1)
  })

  it('E5b: a retry of a purchase handed back to the sweep ignores its stored result', async () => {
    // R15: red if the stored checkoutResult is read first: the retry answers completed.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buyPlan(wallet.id, 'loc99-e5b')
    const payment = await findPaymentByKey(a.dataSource, 'loc99-e5b')
    expect(payment.metadata?.checkoutResult).toBeDefined()
    await a.dataSource
      .getRepository(Payment)
      .update(payment.id, { status: PaymentStatus.PROCESSING })

    await expect(buyPlan(wallet.id, 'loc99-e5b')).rejects.toMatchObject(IN_PROGRESS)
  })

  it('E5c: a retry on another instance says in progress once the pending payment is debited', async () => {
    // R15: red if the pending branch stops looking at the debit: the retry answers 201 pending.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    parkFirstCall(a.checkout, 'closeWalletPayment', gate)
    const purchase = buyPlan(wallet.id, 'loc99-e5c')
    await gate.reached
    const dto = planCheckout(BRAND_ID, wallet.id, 'loc99-e5c', 'dropi-roax')

    await expect(b.checkout.processCheckout(dto)).rejects.toMatchObject(IN_PROGRESS)

    gate.release()
    await expect(purchase).resolves.toMatchObject({ status: 'completed' })
    const payment = await findPaymentByKey(a.dataSource, 'loc99-e5c')
    expect(await debitsOf(payment.id)).toHaveLength(1)
  })

  it('E5c: a retry on another instance before the debit still answers pending', async () => {
    // R15: red if the pending branch stops asking for a debit: the live checkout gets a 409.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    parkFirstCall(a.wallet, 'debit', gate)
    const purchase = buyPlan(wallet.id, 'loc99-e5d')
    await gate.reached
    const dto = planCheckout(BRAND_ID, wallet.id, 'loc99-e5d', 'dropi-roax')

    await expect(b.checkout.processCheckout(dto)).resolves.toMatchObject({ status: 'pending' })

    gate.release()
    await expect(purchase).resolves.toMatchObject({ status: 'completed' })
  })

  it('keeps the close error and a sweepable payment when the hand-over write fails too', async () => {
    // R15: red if handPaymentToSweep lets its error through: the caller loses the close error.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const repo = a.dataSource.getRepository(Payment)
    const realUpdate = repo.update.bind(repo)
    failSubscriptionSave(a)
    // R17: The database going down between two writes cannot be provoked on demand.
    jest.spyOn(repo, 'update').mockImplementation(async (criteria: any, partial: any) => {
      if (partial?.status === PaymentStatus.PROCESSING) throw new Error('Database down')
      return realUpdate(criteria, partial)
    })

    await expect(buyPlan(wallet.id, 'loc99-handover')).rejects.toThrow(CLOSE_ERROR)
    const payment = await findPaymentByKey(a.dataSource, 'loc99-handover')
    expect(payment.status).toBe(PaymentStatus.PENDING)
    jest.restoreAllMocks()

    await expect(buyPlan(wallet.id, 'loc99-handover')).rejects.toMatchObject(IN_PROGRESS)
    await sweepAged(payment.id, '10 minutes')
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await debitsOf(payment.id)).toHaveLength(1)
  })

  it('does not reopen a payment the sweep closed between the failure and the hand-over', async () => {
    // R15: red if the hand-over loses its status predicate: the completed payment reopens.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    // R17: Fixes the order of the failure and the sweep, which no real race can do on demand.
    jest
      .spyOn(a.checkout as any, 'closeWalletPayment')
      .mockImplementationOnce(async (payment: any) => {
        await a.dataSource
          .getRepository(Payment)
          .update(payment.id, { status: PaymentStatus.COMPLETED })
        throw new Error(CLOSE_ERROR)
      })

    await expect(buyPlan(wallet.id, 'loc99-between')).rejects.toThrow(CLOSE_ERROR)

    const payment = await findPaymentByKey(a.dataSource, 'loc99-between')
    expect(payment.status).toBe(PaymentStatus.COMPLETED)
  })
})
