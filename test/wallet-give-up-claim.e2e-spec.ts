import { PaymentStatus } from '../src/payment/entities/payment.entity'
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
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7100002-2222-4333-8444-555555555555'
const BALANCE = 100000
const CLOSE_ERROR = 'Close failed'

describe('The give-up claim of a wallet close that keeps failing (PostgreSQL, LOC-100)', () => {
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

  const buy = (walletId: string, key: string) =>
    a.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, 'dropi-roax'))

  const creditsOf = (paymentId: string) =>
    movements(a.dataSource, paymentId, TransactionType.CREDIT)

  const subscription = () =>
    a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID })

  /** A debited purchase whose close failed, old enough for the sweep to give up on it. */
  const stuckPurchase = async (walletId: string, key: string, age = '2 hours') => {
    // R17: A rejected save is a database failure that cannot be provoked on demand otherwise.
    const spy = jest
      .spyOn(a.checkout as any, 'createOrRenewSubscription')
      .mockRejectedValue(new Error(CLOSE_ERROR))
    await expect(buy(walletId, key)).rejects.toThrow(CLOSE_ERROR)
    spy.mockRestore()
    const payment = await findPaymentByKey(a.dataSource, key)
    await backdate(a.dataSource, payment.id, age)
    return payment
  }

  // R17: The rival sweep must fail its close while the first one holds the brand lock.
  const failRivalClose = () =>
    jest.spyOn(b.checkout as any, 'closeWalletPayment').mockRejectedValue(new Error(CLOSE_ERROR))

  /** The first sweep parks inside its close and the connection of its payment lock dies. */
  const sweepThatLosesItsLock = async (paymentId: string) => {
    const gate = createGate()
    parkFirstCall(a.checkout, 'createOrRenewSubscription', gate)
    const sweep = a.checkout.reconcileWalletPayment(paymentId).catch(() => undefined)
    await gate.reached
    const killed = await a.dataSource.query(
      `SELECT pg_terminate_backend(l.pid) FROM pg_locks l JOIN pg_database d ON d.oid = l.database
       WHERE l.locktype = 'advisory' AND l.granted AND d.datname = current_database()
         AND l.objid = ((hashtext($1)::bigint & 4294967295)::oid)`,
      [`wallet-reconcile:${paymentId}`],
    )
    expect(killed).toHaveLength(1)
    return { gate, sweep }
  }

  it('a close landing after the claim rolls back: credited, without the plan', async () => {
    // R15: red without the claim: the late close completes it and the plan comes free.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await stuckPurchase(wallet.id, 'late-close')
    const { gate, sweep } = await sweepThatLosesItsLock(payment.id)
    failRivalClose()
    const walletService = (b.checkout as any).walletService
    const realCredit = walletService.credit.bind(walletService)
    // R17: Holds the credit open so the late close lands exactly between claim and refund.
    jest.spyOn(walletService, 'credit').mockImplementation(async (...args: any[]) => {
      gate.release()
      await sweep
      return realCredit(...args)
    })

    const result = await b.checkout.reconcileWalletPayment(payment.id)

    expect(result.outcome).toBe('refunded')
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(payment.id)).toHaveLength(1)
    expect(await subscription()).toBeNull()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('a close landing before the claim wins: applied, without a credit', async () => {
    // R15: red if the claim drops its status condition: the completed payment gets its credit.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await stuckPurchase(wallet.id, 'early-close')
    const { gate, sweep } = await sweepThatLosesItsLock(payment.id)
    failRivalClose()
    const eventRepo = (b.checkout as any).subscriptionEventRepo
    const realFindOne = eventRepo.findOne.bind(eventRepo)
    // R17: Lands the close right after the give-up check read that nothing was applied.
    jest.spyOn(eventRepo, 'findOne').mockImplementation(async (...args: any[]) => {
      const read = await realFindOne(...args)
      gate.release()
      await sweep
      return read
    })

    const result = await b.checkout.reconcileWalletPayment(payment.id)

    expect(result).toMatchObject({ outcome: 'noop', status: PaymentStatus.COMPLETED })
    expect(await creditsOf(payment.id)).toHaveLength(0)
    expect((await subscription())?.lastPaymentId).toBe(payment.id)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('a claim whose credit fails is credited by a later sweep, past the failed age floor', async () => {
    // R15: red without the given-up clause in the sweep: past 30 days it stays failed forever.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await stuckPurchase(wallet.id, 'floor', '40 days')
    failRivalClose()
    // R17: A rejected credit is a database failure that cannot be provoked on demand.
    const credit = jest
      .spyOn((b.checkout as any).walletService, 'credit')
      .mockRejectedValueOnce(new Error('Credit failed'))

    await b.tasks.reconcileWalletPayments()
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await creditsOf(payment.id)).toHaveLength(0)
    credit.mockRestore()

    await b.tasks.reconcileWalletPayments()
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(payment.id)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('a retry cannot reopen a claimed payment, which is only ever credited', async () => {
    // R15: red without the given-up check on retry: it goes pending and closes with the plan.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await stuckPurchase(wallet.id, 'retry-claimed')
    failRivalClose()
    // R17: A rejected credit is a database failure that cannot be provoked on demand.
    const credit = jest
      .spyOn((b.checkout as any).walletService, 'credit')
      .mockRejectedValueOnce(new Error('Credit failed'))
    await b.checkout.reconcileWalletPayment(payment.id)
    credit.mockRestore()

    await expect(buy(wallet.id, 'retry-claimed')).rejects.toMatchObject({
      response: { code: 'WALLET_DEBIT_FAILED' },
    })
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await subscription()).toBeNull()

    await b.checkout.reconcileWalletPayment(payment.id)
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })
})
