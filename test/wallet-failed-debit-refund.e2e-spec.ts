import { AuditLog } from '../src/audit/entities/auditLog.entity'
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
  someoneWaitsOnAdvisoryLock,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7970002-2222-4333-8444-555555555555'
const BALANCE = 100000
const LOST = { response: { code: 'WALLET_DEBIT_FAILED' } }

describe('Failed wallet payment with a recorded debit (PostgreSQL, two instances, LOC-97)', () => {
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

  /** Debits for real, runs `afterCommit`, then loses the response as a cut connection would. */
  const loseDebitResponse = (
    afterCommit: (paymentId: string) => Promise<void> = async () => {},
  ) => {
    const original = a.wallet.debit.bind(a.wallet)
    // R17: A lost response after the commit cannot be provoked on demand with a real connection.
    jest.spyOn(a.wallet, 'debit').mockImplementationOnce(async (...args) => {
      await original(...args)
      await afterCommit((args[2] as { referenceId: string }).referenceId)
      throw new Error('connection lost after commit')
    })
  }

  const failWithDebit = async (walletId: string, key: string) => {
    loseDebitResponse()
    await expect(
      a.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, 'dropi-roax')),
    ).rejects.toMatchObject({ response: { code: 'WALLET_DEBIT_FAILED' } })
    const payment = await findPaymentByKey(a.dataSource, key)
    expect(payment.status).toBe(PaymentStatus.FAILED)
    expect(await balanceOf(a.dataSource, walletId)).toBe(BALANCE - PLAN_PRICE)
    return payment
  }

  /** Old enough for any sweep: specs running at once share this database and sweep all brands. */
  const failOldWithDebit = async (walletId: string, key: string) => {
    const payment = await failWithDebit(walletId, key)
    await backdate(a.dataSource, payment.id)
    return payment
  }

  const retry = (walletId: string, key: string) =>
    a.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, 'dropi-roax'))

  const expectRefundedWithoutPlan = async (paymentId: string, walletId: string) => {
    expect(await statusOf(a.dataSource, paymentId)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, paymentId, TransactionType.CREDIT)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, walletId)).toBe(BALANCE)
    const subscription = a.dataSource.getRepository(Subscription)
    expect(await subscription.findOneBy({ brandId: BRAND_ID })).toBeNull()
  }

  it('P1: a retry waits for the sweep that is crediting the payment and never completes it', async () => {
    // R15: red if the retry stops taking the payment lock: it does not wait for the sweep.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await failOldWithDebit(wallet.id, 'loc97-p1')
    const gate = createGate()
    const credit = b.wallet.credit.bind(b.wallet)
    // R17: Holding the sweep between its credit and its refunded write is this exact interleaving.
    jest.spyOn(b.wallet, 'credit').mockImplementationOnce(async (...args) => {
      const credited = await credit(...args)
      gate.arrive()
      await gate.wait
      return credited
    })
    const sweep = b.tasks.reconcileWalletPayments()
    await gate.reached

    const retried = retry(wallet.id, 'loc97-p1')
    const retryWaited = await someoneWaitsOnAdvisoryLock(a.dataSource)
    gate.release()

    await expect(retried).rejects.toMatchObject(LOST)
    await sweep
    expect(retryWaited).toBe(true)
    await expectRefundedWithoutPlan(payment.id, wallet.id)
  })

  it('P2: a retry after a credit that lost its response does not complete the payment', async () => {
    // R15: red if the retry stops looking at the credit: the plan comes free with the money back.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await failOldWithDebit(wallet.id, 'loc97-p2')
    const credit = b.wallet.credit.bind(b.wallet)
    // R17: A lost response after the commit cannot be provoked on demand with a real connection.
    jest.spyOn(b.wallet, 'credit').mockImplementationOnce(async (...args) => {
      await credit(...args)
      throw new Error('connection lost after commit')
    })
    await b.tasks.reconcileWalletPayments()
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)

    await expect(retry(wallet.id, 'loc97-p2')).rejects.toMatchObject(LOST)
    await backdate(a.dataSource, payment.id)
    await b.tasks.reconcileWalletPayments()

    await expectRefundedWithoutPlan(payment.id, wallet.id)
  })

  it('P3: a retry before any credit completes on the same debit, and the sweep leaves it', async () => {
    // R15: red if the retry is refused for having a debit: the buyer never gets the plan.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await failWithDebit(wallet.id, 'loc97-p3')

    await expect(retry(wallet.id, 'loc97-p3')).resolves.toMatchObject({ status: 'completed' })
    await backdate(a.dataSource, payment.id)
    await b.tasks.reconcileWalletPayments()

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await movements(a.dataSource, payment.id, TransactionType.DEBIT)).toHaveLength(1)
    expect(await movements(a.dataSource, payment.id, TransactionType.CREDIT)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('R2: a retry does not revive an older purchase over a newer one of another plan', async () => {
    // R15: red if the retry rewrites createdAt of a debited payment: it passes for the newest.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const older = await failWithDebit(wallet.id, 'loc97-r2-a')
    await b.checkout.processCheckout(planCheckout(BRAND_ID, wallet.id, 'loc97-r2-b', 'growth'))
    const newer = await findPaymentByKey(a.dataSource, 'loc97-r2-b')

    await expect(retry(wallet.id, 'loc97-r2-a')).rejects.toMatchObject(LOST)
    await backdate(a.dataSource, older.id)
    await b.tasks.reconcileWalletPayments()

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, older.id, TransactionType.DEBIT)).toHaveLength(1)
    expect(await movements(a.dataSource, older.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await statusOf(a.dataSource, newer.id)).toBe(PaymentStatus.COMPLETED)
    const subscription = a.dataSource.getRepository(Subscription)
    expect(await subscription.findOneBy({ brandId: BRAND_ID })).toMatchObject({
      planSlug: 'growth',
      lastPaymentId: newer.id,
    })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('R2b: a retry over a newer purchase of the same plan completes as an extension', async () => {
    // R15: red if the close treats the same plan as a conflict: the retry is refused.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const older = await failWithDebit(wallet.id, 'loc97-r2b-a')
    await retry(wallet.id, 'loc97-r2b-b')
    const newer = await findPaymentByKey(a.dataSource, 'loc97-r2b-b')
    const subscription = a.dataSource.getRepository(Subscription)
    const before = await subscription.findOneBy({ brandId: BRAND_ID })

    await expect(retry(wallet.id, 'loc97-r2b-a')).resolves.toMatchObject({ status: 'completed' })
    await backdate(a.dataSource, older.id)
    await b.tasks.reconcileWalletPayments()

    const after = await subscription.findOneBy({ brandId: BRAND_ID })
    expect(after!.lastPaymentId).toBe(newer.id)
    const extended = new Date(before!.currentPeriodEnd)
    extended.setDate(extended.getDate() + 30)
    expect(after!.currentPeriodEnd.toISOString()).toBe(extended.toISOString())
    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.COMPLETED)
    expect(await movements(a.dataSource, older.id, TransactionType.DEBIT)).toHaveLength(1)
    expect(await movements(a.dataSource, older.id, TransactionType.CREDIT)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
  })

  it('R3: a retry of an older purchase does not open the way to one older than the newest', async () => {
    // R15: red if the close moves lastPaymentId back to the retry: the middle purchase takes the plan.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const oldest = await failWithDebit(wallet.id, 'loc97-r3-a')
    const gate = createGate()
    parkFirstCall(b.wallet, 'debit', gate)
    const middle = b.checkout.processCheckout(
      planCheckout(BRAND_ID, wallet.id, 'loc97-r3-c', 'growth'),
    )
    await gate.reached
    await retry(wallet.id, 'loc97-r3-b')
    const newest = await findPaymentByKey(a.dataSource, 'loc97-r3-b')
    const middlePayment = await findPaymentByKey(a.dataSource, 'loc97-r3-c')

    await expect(retry(wallet.id, 'loc97-r3-a')).resolves.toMatchObject({ status: 'completed' })
    gate.release()
    await expect(middle).rejects.toMatchObject(LOST)
    await backdate(a.dataSource, middlePayment.id, '5 minutes')
    await b.tasks.reconcileWalletPayments()

    const subscription = a.dataSource.getRepository(Subscription)
    expect(await subscription.findOneBy({ brandId: BRAND_ID })).toMatchObject({
      planSlug: 'dropi-roax',
      lastPaymentId: newest.id,
    })
    expect(await statusOf(a.dataSource, oldest.id)).toBe(PaymentStatus.COMPLETED)
    expect(await statusOf(a.dataSource, newest.id)).toBe(PaymentStatus.COMPLETED)
    expect(await statusOf(a.dataSource, middlePayment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, middlePayment.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
  })

  it('R3b: a plan change hands back an older retry that closed under a newer purchase', async () => {
    // R15: red if the overlap is searched through lastPaymentId: the retry stays charged.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const oldest = await failWithDebit(wallet.id, 'loc97-r3b-a')
    await retry(wallet.id, 'loc97-r3b-b')
    const sameplan = await findPaymentByKey(a.dataSource, 'loc97-r3b-b')
    await new Promise((resolve) => setTimeout(resolve, 20))
    const gate = createGate()
    parkFirstCall(b.wallet, 'debit', gate)
    const change = b.checkout.processCheckout(
      planCheckout(BRAND_ID, wallet.id, 'loc97-r3b-c', 'growth'),
    )
    await gate.reached

    await expect(retry(wallet.id, 'loc97-r3b-a')).resolves.toMatchObject({ status: 'completed' })
    gate.release()
    await change
    await backdate(a.dataSource, oldest.id)
    await b.tasks.reconcileWalletPayments()

    const newest = await findPaymentByKey(a.dataSource, 'loc97-r3b-c')
    const subscription = a.dataSource.getRepository(Subscription)
    expect(await subscription.findOneBy({ brandId: BRAND_ID })).toMatchObject({
      planSlug: 'growth',
      lastPaymentId: newest.id,
    })
    expect(await statusOf(a.dataSource, oldest.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, oldest.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await statusOf(a.dataSource, sameplan.id)).toBe(PaymentStatus.COMPLETED)
    expect(await movements(a.dataSource, sameplan.id, TransactionType.CREDIT)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
  })

  const expectNotCredited = async (paymentId: string, walletId: string, charged: number) => {
    // R17: The error log is the only trace this case leaves for whoever must look at the row.
    const logged = jest.spyOn((b.checkout as any).log, 'error')
    await a.dataSource.query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId])
    await backdate(a.dataSource, paymentId)

    await b.tasks.reconcileWalletPayments()

    expect(await statusOf(a.dataSource, paymentId)).toBe(PaymentStatus.FAILED)
    expect(await movements(a.dataSource, paymentId, TransactionType.CREDIT)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, walletId)).toBe(BALANCE - charged)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(paymentId))
  }

  it('P4: does not credit a failed payment the subscription names as its last payment', async () => {
    // R15: red if the sweep stops comparing lastPaymentId: it credits a plan already applied.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await retry(wallet.id, 'loc97-p4')
    const payment = await findPaymentByKey(a.dataSource, 'loc97-p4')
    await a.dataSource.query(`DELETE FROM subscription_events WHERE "paymentId" = $1`, [payment.id])

    await expectNotCredited(payment.id, wallet.id, PLAN_PRICE)
  })

  it('P4b: does not credit a failed payment that only a subscription event names', async () => {
    // R15: red if the sweep stops looking at the subscription event: it credits an applied plan.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await retry(wallet.id, 'loc97-p4b-a')
    await retry(wallet.id, 'loc97-p4b-b')
    const payment = await findPaymentByKey(a.dataSource, 'loc97-p4b-a')

    await expectNotCredited(payment.id, wallet.id, 2 * PLAN_PRICE)
  })

  it('E3: credits a failed payment with a debit once, restores the balance and leaves one log', async () => {
    // R15: red if the sweep skips failed payments again: the money stays debited.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await failOldWithDebit(wallet.id, 'loc97-e3')

    await b.tasks.reconcileWalletPayments()
    await b.tasks.reconcileWalletPayments()

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, payment.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
    const logs = await a.dataSource.getRepository(AuditLog).findBy({
      entityId: payment.id,
      action: 'wallet_payment_refunded',
    })
    expect(logs).toHaveLength(1)
  })

  it('E4: keeps the payment failed when the credit fails and refunds it on the next pass', async () => {
    // R15: red if the refund claims an intermediate processing status: a crash could complete it.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await failOldWithDebit(wallet.id, 'loc97-e4')
    // R17: Forcing one credit failure is the only way to observe the state between two passes.
    jest.spyOn(b.wallet, 'credit').mockRejectedValueOnce(new Error('credit unavailable'))

    await b.tasks.reconcileWalletPayments()
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await movements(a.dataSource, payment.id, TransactionType.CREDIT)).toHaveLength(0)

    await b.tasks.reconcileWalletPayments()

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, payment.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
    const subscription = a.dataSource.getRepository(Subscription)
    expect(await subscription.findOneBy({ brandId: BRAND_ID })).toBeNull()
  })

  it('E9: leaves completed a payment another instance finished while the debit lost its response', async () => {
    // R15: red if the catch writes failed without a condition: a completed payment turns failed.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    loseDebitResponse(async (paymentId) => {
      await backdate(a.dataSource, paymentId)
      await b.tasks.reconcileWalletPayments()
    })

    const result = await a.checkout.processCheckout(
      planCheckout(BRAND_ID, wallet.id, 'loc97-e9', 'dropi-roax'),
    )

    const payment = await findPaymentByKey(a.dataSource, 'loc97-e9')
    expect(result).toMatchObject({ paymentId: payment.id, status: 'completed' })
    expect(payment.status).toBe(PaymentStatus.COMPLETED)
    expect(await movements(a.dataSource, payment.id, TransactionType.CREDIT)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
    const subscription = a.dataSource.getRepository(Subscription)
    const plan = await subscription.findOneBy({ brandId: BRAND_ID })
    expect(plan).toMatchObject({ planSlug: 'dropi-roax', lastPaymentId: payment.id })
  })
})
