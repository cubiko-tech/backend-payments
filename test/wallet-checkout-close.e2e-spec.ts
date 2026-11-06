import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  backdate,
  balanceOf,
  cleanBrand,
  createGate,
  findPaymentByKey,
  Gate,
  movements,
  parkFirstCall,
  planCheckout,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  someoneWaitsOnAdvisoryLock,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'
import { scopeSweepsToBrand } from './support/brand-scoped-sweep'

const BRAND_ID = 'a7970003-2222-4333-8444-555555555555'
const BALANCE = 100000
const LOST = { response: { code: 'WALLET_DEBIT_FAILED' } }

describe('Closing a wallet checkout against other purchases and the sweep (PostgreSQL, LOC-97)', () => {
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

  const buy = (instance: RaceInstance, walletId: string, key: string, plan: string) =>
    instance.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, plan))

  /** Starts a purchase on `instance` and parks it, debited, right before it closes. */
  const buyAndParkBeforeClose = async (
    instance: RaceInstance,
    walletId: string,
    key: string,
    plan: string,
  ) => {
    const gate: Gate = createGate()
    parkFirstCall(instance.checkout, 'closeWalletPayment', gate)
    const purchase = buy(instance, walletId, key, plan)
    await gate.reached
    return { gate, purchase, payment: await findPaymentByKey(instance.dataSource, key) }
  }

  const sweepOldPayment = async (paymentId: string) => {
    await backdate(a.dataSource, paymentId)
    await b.tasks.reconcileWalletPayments()
  }

  const currentPlan = () =>
    a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID })

  /** Parks a purchase inside its close, holding the brand lock, past the superseded check. */
  const buyAndParkInsideClose = async (walletId: string, key: string, plan: string) => {
    const gate = createGate()
    parkFirstCall(a.checkout, 'createOrRenewSubscription', gate)
    const purchase = buy(a, walletId, key, plan)
    await gate.reached
    return { gate, purchase, payment: await findPaymentByKey(a.dataSource, key) }
  }

  const waitForStatus = async (paymentId: string, status: PaymentStatus) => {
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && (await statusOf(a.dataSource, paymentId)) !== status) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  it('E5: refunds a payment the sweep claimed while its checkout was about to complete it', async () => {
    // R15: red if the close accepts processing again: it ends completed with one credit.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const old = await buyAndParkInsideClose(wallet.id, 'loc97-e5-a', 'dropi-roax')
    const newer = buy(b, wallet.id, 'loc97-e5-b', 'growth')
    await someoneWaitsOnAdvisoryLock(a.dataSource)
    await backdate(a.dataSource, old.payment.id)
    const sweep = b.tasks.reconcileWalletPayments()
    await waitForStatus(old.payment.id, PaymentStatus.PROCESSING)

    old.gate.release()

    await expect(old.purchase).rejects.toMatchObject(LOST)
    await Promise.all([newer, sweep])
    const newerPayment = await findPaymentByKey(a.dataSource, 'loc97-e5-b')
    expect(await statusOf(a.dataSource, old.payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, old.payment.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await currentPlan()).toMatchObject({
      planSlug: 'growth',
      lastPaymentId: newerPayment.id,
    })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('E5c: does not complete a payment the sweep already refunded for a newer purchase', async () => {
    // R15: red only with both the superseded check and the status condition removed from the close.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const old = await buyAndParkBeforeClose(a, wallet.id, 'loc97-e5-old', 'dropi-roax')
    await buy(b, wallet.id, 'loc97-e5-new', 'growth')
    await sweepOldPayment(old.payment.id)
    const newer = await findPaymentByKey(a.dataSource, 'loc97-e5-new')
    expect(await statusOf(a.dataSource, old.payment.id)).toBe(PaymentStatus.REFUNDED)

    old.gate.release()

    await expect(old.purchase).rejects.toMatchObject(LOST)
    expect(await statusOf(a.dataSource, old.payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, old.payment.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await currentPlan()).toMatchObject({ planSlug: 'growth', lastPaymentId: newer.id })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('E5b: does not complete a refunded payment even when the brand bought its plan again', async () => {
    // R15: red if the completed update loses its status condition: refunded turns completed.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const old = await buyAndParkBeforeClose(a, wallet.id, 'loc97-e5b-old', 'dropi-roax')
    await buy(b, wallet.id, 'loc97-e5b-growth', 'growth')
    await sweepOldPayment(old.payment.id)
    expect(await statusOf(a.dataSource, old.payment.id)).toBe(PaymentStatus.REFUNDED)
    await buy(b, wallet.id, 'loc97-e5b-again', 'dropi-roax')
    const before = await currentPlan()

    old.gate.release()

    await expect(old.purchase).rejects.toMatchObject(LOST)
    expect(await statusOf(a.dataSource, old.payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, old.payment.id, TransactionType.CREDIT)).toHaveLength(1)
    // R15: red if the close saves the subscription outside its transaction: the rollback misses it.
    const after = await currentPlan()
    expect(after!.lastPaymentId).toBe(before!.lastPaymentId)
    expect(after!.currentPeriodEnd.toISOString()).toBe(before!.currentPeriodEnd.toISOString())
  })

  it('E6: gives the plan to the newer purchase over an existing subscription and refunds the older', async () => {
    // R15: red if the close stops looking at the newer purchase: the older one overwrites the plan.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buy(b, wallet.id, 'loc97-e6-first', 'starter')
    const older = await buyAndParkBeforeClose(a, wallet.id, 'loc97-e6-a', 'dropi-roax')
    await buy(b, wallet.id, 'loc97-e6-b', 'growth')
    const newer = await findPaymentByKey(a.dataSource, 'loc97-e6-b')

    older.gate.release()
    await expect(older.purchase).rejects.toMatchObject(LOST)
    await sweepOldPayment(older.payment.id)

    expect(await currentPlan()).toMatchObject({ planSlug: 'growth', lastPaymentId: newer.id })
    expect(await statusOf(a.dataSource, older.payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, older.payment.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
  })

  it('E6b: serializes two closes of one brand, so the older cannot overwrite the newer plan', async () => {
    // R15: red if the brand lock is removed: the newer closes first and the older overwrites it.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    // createOrRenewSubscription runs inside the close, with the brand lock already held.
    parkFirstCall(a.checkout, 'createOrRenewSubscription', gate)
    const older = buy(a, wallet.id, 'loc97-e6b-a', 'dropi-roax')
    await gate.reached

    const newer = buy(b, wallet.id, 'loc97-e6b-b', 'growth')
    const newerWaited = await someoneWaitsOnAdvisoryLock(a.dataSource)
    gate.release()
    await Promise.allSettled([older, newer])

    const newerPayment = await findPaymentByKey(a.dataSource, 'loc97-e6b-b')
    expect(newerWaited).toBe(true)
    expect(await currentPlan()).toMatchObject({
      planSlug: 'growth',
      lastPaymentId: newerPayment.id,
    })
  })

  it('E7: refunds the older purchase when it resumes after the newer one finished', async () => {
    // R15: red if the createdAt comparison is dropped: the older purchase takes the plan back.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const older = await buyAndParkBeforeClose(a, wallet.id, 'loc97-e7-a', 'dropi-roax')
    await buy(b, wallet.id, 'loc97-e7-b', 'growth')
    const newer = await findPaymentByKey(a.dataSource, 'loc97-e7-b')

    older.gate.release()
    await expect(older.purchase).rejects.toMatchObject(LOST)
    await sweepOldPayment(older.payment.id)

    expect(await currentPlan()).toMatchObject({ planSlug: 'growth', lastPaymentId: newer.id })
    expect(await statusOf(a.dataSource, older.payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await statusOf(a.dataSource, newer.id)).toBe(PaymentStatus.COMPLETED)
    expect(await movements(a.dataSource, older.payment.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('E7b: refunds the older purchase when the newer one overlapped its subscription insert', async () => {
    // R15: red if the newer close stops handing back the overlapped older one: both stay charged.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const older = await buyAndParkInsideClose(wallet.id, 'loc97-e7b-a', 'dropi-roax')
    const newer = buy(b, wallet.id, 'loc97-e7b-b', 'growth')
    const newerWaited = await someoneWaitsOnAdvisoryLock(a.dataSource)

    older.gate.release()
    await Promise.allSettled([older.purchase, newer])
    await sweepOldPayment(older.payment.id)

    const newerPayment = await findPaymentByKey(a.dataSource, 'loc97-e7b-b')
    expect(newerWaited).toBe(true)
    expect(await statusOf(a.dataSource, older.payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, older.payment.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await statusOf(a.dataSource, newerPayment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await currentPlan()).toMatchObject({
      planSlug: 'growth',
      lastPaymentId: newerPayment.id,
    })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('E7c: keeps a non-overlapping older purchase charged when the brand changes plan', async () => {
    // R15: red if the overlap comparison is dropped: an ordinary plan change refunds the old plan.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buy(a, wallet.id, 'loc97-e7c-a', 'dropi-roax')
    const first = await findPaymentByKey(a.dataSource, 'loc97-e7c-a')
    await buy(b, wallet.id, 'loc97-e7c-b', 'growth')
    await sweepOldPayment(first.id)

    expect(await statusOf(a.dataSource, first.id)).toBe(PaymentStatus.COMPLETED)
    expect(await movements(a.dataSource, first.id, TransactionType.CREDIT)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
  })

  it('E7d: refunds the older purchase when the newer one is debited but has not closed yet', async () => {
    // R15: red if the close ignores a newer debited purchase: the older completes first and is kept.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const olderGate = createGate()
    parkFirstCall(a.wallet, 'debit', olderGate)
    const older = buy(a, wallet.id, 'loc97-e7d-a', 'dropi-roax')
    await olderGate.reached
    const olderPayment = await findPaymentByKey(a.dataSource, 'loc97-e7d-a')
    const newer = await buyAndParkBeforeClose(b, wallet.id, 'loc97-e7d-b', 'growth')

    olderGate.release()
    await expect(older).rejects.toMatchObject(LOST)
    newer.gate.release()
    await newer.purchase
    await sweepOldPayment(olderPayment.id)

    expect(await statusOf(a.dataSource, olderPayment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await currentPlan()).toMatchObject({
      planSlug: 'growth',
      lastPaymentId: newer.payment.id,
    })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('E8: refuses to cancel a debited payment, and its checkout still completes', async () => {
    // R15: red if cancelPayment stops looking at the debit: the debited payment ends failed.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const parked = await buyAndParkBeforeClose(a, wallet.id, 'loc97-e8', 'dropi-roax')

    await expect(b.payments.cancelPayment(parked.payment.id)).rejects.toMatchObject({
      response: { code: 'PAYMENT_NOT_CANCELLABLE' },
    })
    parked.gate.release()
    await parked.purchase

    expect(await statusOf(a.dataSource, parked.payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await currentPlan()).toMatchObject({ planSlug: 'dropi-roax' })
    expect(await movements(a.dataSource, parked.payment.id, TransactionType.CREDIT)).toHaveLength(0)
  })

  it('E8b: cancels before the debit, and the later debit aborts without charging', async () => {
    // R15: red if cancelPayment stops writing failed: the later debit charges the payment.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    parkFirstCall(a.wallet, 'debit', gate)
    const purchase = buy(a, wallet.id, 'loc97-e8b', 'dropi-roax')
    await gate.reached
    const payment = await findPaymentByKey(a.dataSource, 'loc97-e8b')

    await b.payments.cancelPayment(payment.id)
    gate.release()

    await expect(purchase).rejects.toMatchObject(LOST)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await movements(a.dataSource, payment.id, TransactionType.DEBIT)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })
})
