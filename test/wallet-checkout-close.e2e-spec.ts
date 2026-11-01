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

const BRAND_ID = 'a7970003-2222-4333-8444-555555555555'
const BALANCE = 100000
const LOST = { response: { code: 'WALLET_DEBIT_FAILED' } }

describe('Closing a wallet checkout against other purchases and the sweep (PostgreSQL, LOC-97)', () => {
  let a: RaceInstance
  let b: RaceInstance

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
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

  it('E5: does not complete a payment the sweep already refunded for a newer purchase', async () => {
    // R15: red if the superseded check is removed from the close: the old plan comes back.
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

    old.gate.release()

    await expect(old.purchase).rejects.toMatchObject(LOST)
    expect(await statusOf(a.dataSource, old.payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, old.payment.id, TransactionType.CREDIT)).toHaveLength(1)
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

  it('E7b: refunds the older purchase when the newer one is debited but has not closed yet', async () => {
    // R15: red if the close ignores a newer debited purchase: the older completes first and is kept.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const olderGate = createGate()
    parkFirstCall(a.wallet, 'debit', olderGate)
    const older = buy(a, wallet.id, 'loc97-e7b-a', 'dropi-roax')
    await olderGate.reached
    const olderPayment = await findPaymentByKey(a.dataSource, 'loc97-e7b-a')
    const newer = await buyAndParkBeforeClose(b, wallet.id, 'loc97-e7b-b', 'growth')

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
