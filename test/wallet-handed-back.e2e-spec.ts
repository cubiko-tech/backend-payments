import { Payment, PaymentStatus } from '../src/payment/entities/payment.entity'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
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
  sweepAfter,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7100001-2222-4333-8444-555555555555'
const BALANCE = 100000
const PLAN = 'dropi-roax'
const OTHER_PLAN = 'dropi-roax-plus'
const CLOSE_ERROR = 'Close failed'
const DAY_MS = 24 * 60 * 60 * 1000
const TEN_MINUTES_MS = 10 * 60 * 1000
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

describe('A purchase handed back to the sweep (PostgreSQL, LOC-100)', () => {
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

  const buy = (instance: RaceInstance, walletId: string, key: string, plan = PLAN) =>
    instance.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, plan))

  const creditsOf = (paymentId: string) =>
    movements(a.dataSource, paymentId, TransactionType.CREDIT)

  const subscription = () =>
    a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID })

  const daysLeft = (sub: Subscription) =>
    Math.round((new Date(sub.currentPeriodEnd).getTime() - Date.now()) / DAY_MS)

  /** The older purchase ends its close, stored result included, while the newer one is open. */
  const handBack = async (walletId: string, prefix: string) => {
    const olderGate = createGate()
    parkFirstCall(a.checkout, 'createOrRenewSubscription', olderGate)
    const older = buy(a, walletId, `${prefix}-a`, PLAN)
    await olderGate.reached
    const newerGate = createGate()
    parkFirstCall(b.checkout, 'closeWalletPayment', newerGate)
    const newer = buy(b, walletId, `${prefix}-b`, OTHER_PLAN)
    await newerGate.reached
    olderGate.release()
    await older
    newerGate.release()
    await newer
    jest.restoreAllMocks()
    const handedBack = await findPaymentByKey(a.dataSource, `${prefix}-a`)
    expect(handedBack.status).toBe(PaymentStatus.PROCESSING)
    return handedBack
  }

  it('credits a purchase handed back and bought again, which paid for days it no longer has', async () => {
    // R15: red without isHandedBackPurchase: completed, no credit, balance 40300.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const handedBack = await handBack(wallet.id, 'bought-again')
    await buy(a, wallet.id, 'bought-again-c', PLAN)
    const again = await findPaymentByKey(a.dataSource, 'bought-again-c')

    await sweepAfter(a, handedBack.id, TEN_MINUTES_MS)

    expect(await statusOf(a.dataSource, handedBack.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(handedBack.id)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
    const sub = (await subscription())!
    expect(sub.lastPaymentId).toBe(again.id)
    expect(daysLeft(sub)).toBe(30)
  })

  it('credits it without closing, so a close that keeps failing cannot leave it stuck', async () => {
    // R15: red without isHandedBackPurchase: it reaches the failing close and stays processing.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const handedBack = await handBack(wallet.id, 'stuck')
    await buy(a, wallet.id, 'stuck-c', PLAN)
    // R17: A close that keeps failing is a database failure that cannot be provoked on demand.
    const close = jest
      .spyOn(b.checkout as any, 'closeWalletPayment')
      .mockRejectedValue(new Error(CLOSE_ERROR))

    await sweepAfter(b, handedBack.id, TWO_HOURS_MS)

    expect(close).not.toHaveBeenCalled()
    expect(await statusOf(a.dataSource, handedBack.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(handedBack.id)).toHaveLength(1)
  })

  it('credits it once with two sweeps at once', async () => {
    // R15: red if the sweep drops the payment lock: both record the refund in the audit log.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const handedBack = await handBack(wallet.id, 'two-sweeps')
    await buy(a, wallet.id, 'two-sweeps-c', PLAN)

    await Promise.all([
      sweepAfter(a, handedBack.id, TEN_MINUTES_MS),
      sweepAfter(b, handedBack.id, TEN_MINUTES_MS),
    ])

    expect(await creditsOf(handedBack.id)).toHaveLength(1)
    const audits = await a.dataSource
      .getRepository(AuditLog)
      .countBy({ entityId: handedBack.id, action: 'wallet_payment_refunded' })
    expect(audits).toBe(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
  })

  it('stays processing when the credit fails and credits it in the next sweep', async () => {
    // R15: red if a failed credit still moves the row to refunded: the money never comes back.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const handedBack = await handBack(wallet.id, 'credit-fails')
    await buy(a, wallet.id, 'credit-fails-c', PLAN)
    // R17: A rejected credit is a database failure that cannot be provoked on demand.
    const credit = jest
      .spyOn((a.checkout as any).walletService, 'credit')
      .mockRejectedValueOnce(new Error('Credit failed'))

    const first = await sweepAfter(a, handedBack.id, TEN_MINUTES_MS)
    expect(first.outcome).toBe('noop')
    expect(await statusOf(a.dataSource, handedBack.id)).toBe(PaymentStatus.PROCESSING)
    credit.mockRestore()

    await sweepAfter(a, handedBack.id, TEN_MINUTES_MS)
    expect(await statusOf(a.dataSource, handedBack.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(handedBack.id)).toHaveLength(1)
  })

  it('answers a retry with in-progress and then refunded, never the completed it stored', async () => {
    // R15: red without the refunded check in resolvePaymentStateOutcome: the retry says completed.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const handedBack = await handBack(wallet.id, 'retry')
    expect(handedBack.metadata?.checkoutResult).toMatchObject({ status: 'completed' })

    await expect(buy(a, wallet.id, 'retry-a')).rejects.toMatchObject({
      response: { code: 'IDEMPOTENT_CHECKOUT_IN_PROGRESS' },
    })
    await sweepAfter(a, handedBack.id, TEN_MINUTES_MS)

    expect(await buy(a, wallet.id, 'retry-a')).toEqual({
      paymentId: handedBack.id,
      status: 'refunded',
    })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('credits it while the repurchase is still open, and the repurchase then applies', async () => {
    // R15: red if isLastPaymentNewer stops comparing dates: the repurchase loses to the older one.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const handedBack = await handBack(wallet.id, 'open')
    const gate = createGate()
    parkFirstCall(b.checkout, 'closeWalletPayment', gate)
    const repurchase = buy(b, wallet.id, 'open-c', PLAN)
    await gate.reached

    await sweepAfter(a, handedBack.id, TEN_MINUTES_MS)
    expect(await statusOf(a.dataSource, handedBack.id)).toBe(PaymentStatus.REFUNDED)

    gate.release()
    await repurchase
    const again = await findPaymentByKey(a.dataSource, 'open-c')
    expect(await statusOf(a.dataSource, again.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(again.id)).toHaveLength(0)
    expect((await subscription())?.lastPaymentId).toBe(again.id)
    expect(await creditsOf(handedBack.id)).toHaveLength(1)
  })

  it('settles three overlapped purchases when the newest is of the plan of the oldest', async () => {
    // R15: red without isHandedBackPurchase: the oldest ends completed with no credit.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const oldestGate = createGate()
    parkFirstCall(a.checkout, 'createOrRenewSubscription', oldestGate)
    const oldest = buy(a, wallet.id, 'three-a', PLAN)
    await oldestGate.reached
    const middleGate = createGate()
    parkFirstCall(b.checkout, 'createOrRenewSubscription', middleGate)
    const middle = buy(b, wallet.id, 'three-b', OTHER_PLAN)
    expect(await someoneWaitsOnAdvisoryLock(a.dataSource)).toBe(true)
    oldestGate.release()
    await middleGate.reached
    const newest = buy(a, wallet.id, 'three-c', PLAN)
    expect(await someoneWaitsOnAdvisoryLock(a.dataSource)).toBe(true)
    middleGate.release()
    await Promise.all([oldest, middle, newest])
    const [first, second, third] = await Promise.all(
      ['three-a', 'three-b', 'three-c'].map((key) => findPaymentByKey(a.dataSource, key)),
    )

    // Middle first: while it stays open, the oldest also loses its close to it.
    await sweepAfter(a, second.id, TEN_MINUTES_MS)
    await sweepAfter(a, first.id, TEN_MINUTES_MS)

    expect(await statusOf(a.dataSource, first.id)).toBe(PaymentStatus.REFUNDED)
    expect(await statusOf(a.dataSource, second.id)).toBe(PaymentStatus.REFUNDED)
    expect(await statusOf(a.dataSource, third.id)).toBe(PaymentStatus.COMPLETED)
    expect((await subscription())?.lastPaymentId).toBe(third.id)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('does not credit an old row in processing with its event and no paidAt', async () => {
    // R15: red if isHandedBackPurchase stops reading paidAt: the row gets a credit with its days.
    // Seeded: no current path leaves this row, it stands for those written by earlier versions.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const row = await handBack(wallet.id, 'old-row')
    await a.dataSource.getRepository(Payment).update(row.id, { paidAt: null as any })
    await backdate(a.dataSource, row.id, '20 minutes')
    await buy(a, wallet.id, 'old-row-c', PLAN)

    await sweepAfter(a, row.id, TEN_MINUTES_MS)

    expect(await creditsOf(row.id)).toHaveLength(0)
    expect(await statusOf(a.dataSource, row.id)).toBe(PaymentStatus.COMPLETED)
  })
})
