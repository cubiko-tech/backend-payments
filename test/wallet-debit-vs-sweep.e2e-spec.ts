import { PaymentAttempt } from '../src/payment/entities/paymentAttempt.entity'
import { PaymentStatus } from '../src/payment/entities/payment.entity'
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
  someoneWaitsOnAdvisoryLock,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7970001-2222-4333-8444-555555555555'
const BALANCE = 100000

describe('Wallet debit against the reconciliation sweep (PostgreSQL, two instances, LOC-97)', () => {
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

  it('E1: makes the sweep wait while a checkout debits, and the payment ends completed', async () => {
    // R15: red if debit stops taking the payment lock: the sweep does not wait and fails the payment.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    // findExistingMovement runs inside the debit transaction, after the lock point.
    parkFirstCall(a.wallet, 'findExistingMovement', gate)
    const key = 'loc97-e1'
    const checkout = a.checkout.processCheckout(
      planCheckout(BRAND_ID, wallet.id, key, 'dropi-roax'),
    )
    await gate.reached

    const payment = await findPaymentByKey(a.dataSource, key)
    await backdate(a.dataSource, payment.id)
    const sweep = b.tasks.reconcileWalletPayments()
    const sweepWaited = await someoneWaitsOnAdvisoryLock(a.dataSource)
    const statusDuringDebit = await statusOf(a.dataSource, payment.id)
    gate.release()
    await Promise.allSettled([checkout, sweep])

    expect(sweepWaited).toBe(true)
    expect(statusDuringDebit).toBe(PaymentStatus.PENDING)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await movements(a.dataSource, payment.id, TransactionType.DEBIT)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('E1b: aborts the debit without charging when the sweep already failed the payment', async () => {
    // R15: red if debit stops re-reading the payment status: it charges a failed payment.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    parkFirstCall(a.wallet, 'debit', gate)
    const key = 'loc97-e1b'
    const checkout = a.checkout.processCheckout(
      planCheckout(BRAND_ID, wallet.id, key, 'dropi-roax'),
    )
    await gate.reached

    const payment = await findPaymentByKey(a.dataSource, key)
    await backdate(a.dataSource, payment.id)
    await b.tasks.reconcileWalletPayments()
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    gate.release()

    await expect(checkout).rejects.toMatchObject({ response: { code: 'WALLET_DEBIT_FAILED' } })
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await movements(a.dataSource, payment.id, TransactionType.DEBIT)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('E2: still fails an old pending payment without debit or live checkout, keeping the balance', async () => {
    // R15: red if the sweep stops writing the failed transition: the payment stays pending.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const key = 'loc97-e2'
    const attempts = a.dataSource.getRepository(PaymentAttempt)
    // R17: The attempt insert is the last step before the debit; failing it models a dead process.
    jest.spyOn(attempts, 'save').mockRejectedValueOnce(new Error('process died before debit'))
    await expect(
      a.checkout.processCheckout(planCheckout(BRAND_ID, wallet.id, key, 'dropi-roax')),
    ).rejects.toThrow('process died before debit')

    const payment = await findPaymentByKey(a.dataSource, key)
    expect(payment.status).toBe(PaymentStatus.PENDING)
    await backdate(a.dataSource, payment.id)

    await b.tasks.reconcileWalletPayments()

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await movements(a.dataSource, payment.id, TransactionType.DEBIT)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })
})
