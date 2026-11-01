import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  backdate,
  balanceOf,
  cleanBrand,
  findPaymentByKey,
  movements,
  planCheckout,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7970002-2222-4333-8444-555555555555'
const BALANCE = 100000

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
    await backdate(a.dataSource, payment.id)
    return payment
  }

  it('E3: credits a failed payment with a debit once, restores the balance and leaves one log', async () => {
    // R15: red if the sweep skips failed payments again: the money stays debited.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const payment = await failWithDebit(wallet.id, 'loc97-e3')

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
    const payment = await failWithDebit(wallet.id, 'loc97-e4')
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
