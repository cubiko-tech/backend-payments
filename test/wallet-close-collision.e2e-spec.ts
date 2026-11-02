import { Repository } from 'typeorm'

import { AuditLog } from '../src/audit/entities/auditLog.entity'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
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

const BRAND_ID = 'a7990002-2222-4333-8444-555555555555'
const BALANCE = 100000
const CLOSE_ERROR = 'Subscription save failed'
const DAY_MS = 24 * 60 * 60 * 1000
const TEN_MINUTES_MS = 10 * 60 * 1000
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

describe('A failed wallet close against other purchases and sweeps (PostgreSQL, LOC-99)', () => {
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

  const buy = (instance: RaceInstance, walletId: string, key: string, plan = 'dropi-roax') =>
    instance.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, plan))

  // R17: A rejected save is a database failure that cannot be provoked on demand otherwise.
  const failSubscriptionSave = (instance: RaceInstance) =>
    jest
      .spyOn(instance.checkout as any, 'createOrRenewSubscription')
      .mockRejectedValue(new Error(CLOSE_ERROR))

  const creditsOf = (paymentId: string) =>
    movements(a.dataSource, paymentId, TransactionType.CREDIT)

  const debitsOf = (paymentId: string) => movements(a.dataSource, paymentId, TransactionType.DEBIT)

  const subscription = () =>
    a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID })

  const auditCount = (paymentId: string, action: string) =>
    a.dataSource.getRepository(AuditLog).countBy({ entityId: paymentId, action })

  const eventsOf = (paymentId: string) =>
    a.dataSource.getRepository(SubscriptionEvent).countBy({ paymentId })

  /** Parks a purchase inside its close on instance `a`, holding the brand lock. */
  const buyAndParkHoldingBrandLock = async (walletId: string, key: string, plan = 'dropi-roax') => {
    const gate = createGate()
    parkFirstCall(a.checkout, 'createOrRenewSubscription', gate)
    const purchase = buy(a, walletId, key, plan)
    await gate.reached
    return { gate, purchase, payment: await findPaymentByKey(a.dataSource, key) }
  }

  it('E6: two first purchases of one plan at once both apply without an index collision', async () => {
    // R15: red if the close drops its brand lock: the second purchase no longer waits for the first.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const { gate, purchase } = await buyAndParkHoldingBrandLock(wallet.id, 'loc99-e6-a')

    const rival = buy(b, wallet.id, 'loc99-e6-b')
    expect(await someoneWaitsOnAdvisoryLock(a.dataSource)).toBe(true)
    gate.release()
    const [first, second] = await Promise.all([purchase, rival])

    expect(first.status).toBe('completed')
    expect(second.status).toBe('completed')
    const sub = (await subscription())!
    const days = (new Date(sub.currentPeriodEnd).getTime() - Date.now()) / DAY_MS
    expect(Math.round(days)).toBe(60)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
  })

  it('E6: two first purchases of two plans at once leave the newer applied and the older credited', async () => {
    // R15: red if the sweep stops crediting the older purchase: it stays open with its debit.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const parked = await buyAndParkHoldingBrandLock(wallet.id, 'loc99-e6-x', 'dropi-roax')

    const rival = buy(b, wallet.id, 'loc99-e6-y', 'dropi-roax-plus')
    expect(await someoneWaitsOnAdvisoryLock(a.dataSource)).toBe(true)
    parked.gate.release()
    await Promise.all([parked.purchase, rival])

    const older = parked.payment
    const newer = await findPaymentByKey(a.dataSource, 'loc99-e6-y')
    await backdate(a.dataSource, older.id)
    await backdate(a.dataSource, newer.id, '9 minutes')
    await a.tasks.reconcileWalletPayments()

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(older.id)).toHaveLength(1)
    expect(await statusOf(a.dataSource, newer.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(newer.id)).toHaveLength(0)
    expect((await subscription())?.planSlug).toBe('dropi-roax-plus')
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('E7: a real unique index collision against an external purchase ends with the plan', async () => {
    // R15: red if a failed close does not hand over: the payment stays pending, not processing.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const paymentRepo = a.dataSource.getRepository(Payment)
    const external = await paymentRepo.save(
      paymentRepo.create({
        brandId: BRAND_ID,
        userId: 'user-loc99',
        provider: PaymentProvider.STRIPE,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: 'dropi-roax',
        amount: PLAN_PRICE,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        metadata: { country: 'CO', taxRate: 0.19, taxName: 'IVA' },
      }),
    )
    const realSave = Repository.prototype.save
    let collided = false
    // R17: The external path takes no brand lock; this fixes when it lands inside the close.
    jest.spyOn(Repository.prototype, 'save').mockImplementation(async function (
      this: Repository<any>,
      ...args: any[]
    ) {
      if (!collided && this.metadata.target === Subscription) {
        collided = true
        await a.checkout.completeExternalPayment(external.id)
      }
      return (realSave as any).apply(this, args)
    } as any)

    await expect(buy(a, wallet.id, 'loc99-e7')).rejects.toMatchObject({
      driverError: { code: '23505' },
    })
    jest.restoreAllMocks()

    const payment = await findPaymentByKey(a.dataSource, 'loc99-e7')
    expect(payment.status).toBe(PaymentStatus.PROCESSING)
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.COMPLETED)

    await backdate(a.dataSource, payment.id)
    await b.tasks.reconcileWalletPayments()

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await eventsOf(payment.id)).toBe(1)
    expect(await debitsOf(payment.id)).toHaveLength(1)
    expect(await creditsOf(payment.id)).toHaveLength(0)
  })

  it('E8: two sweeps at once close a stuck payment once', async () => {
    // R15: red if the sweep drops the payment lock and its close stops claiming by status.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const spy = failSubscriptionSave(a)
    await expect(buy(a, wallet.id, 'loc99-e8-close')).rejects.toThrow(CLOSE_ERROR)
    spy.mockRestore()
    const payment = await findPaymentByKey(a.dataSource, 'loc99-e8-close')

    await Promise.all([
      sweepAfter(a, payment.id, TEN_MINUTES_MS),
      sweepAfter(b, payment.id, TEN_MINUTES_MS),
    ])

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.COMPLETED)
    expect(await eventsOf(payment.id)).toBe(1)
    expect(await auditCount(payment.id, 'checkout_completed')).toBe(1)
    expect(await creditsOf(payment.id)).toHaveLength(0)
  })

  it('E8: two sweeps at once give up on a stuck payment once', async () => {
    // R15: red if the sweep drops the payment lock: both record the refund in the audit log.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    failSubscriptionSave(a)
    failSubscriptionSave(b)
    await expect(buy(a, wallet.id, 'loc99-e8-refund')).rejects.toThrow(CLOSE_ERROR)
    const payment = await findPaymentByKey(a.dataSource, 'loc99-e8-refund')

    await Promise.all([
      sweepAfter(a, payment.id, TWO_HOURS_MS),
      sweepAfter(b, payment.id, TWO_HOURS_MS),
    ])

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(payment.id)).toHaveLength(1)
    expect(await auditCount(payment.id, 'wallet_payment_refunded')).toBe(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('E9: an older and a newer purchase that both fail to close end credited and planless', async () => {
    // R15: red if the sweep always rethrows: the newer purchase never leaves processing.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    failSubscriptionSave(a)
    failSubscriptionSave(b)
    await expect(buy(a, wallet.id, 'loc99-e9-old', 'dropi-roax')).rejects.toThrow(CLOSE_ERROR)
    await expect(buy(a, wallet.id, 'loc99-e9-new', 'dropi-roax-plus')).rejects.toThrow(CLOSE_ERROR)
    const older = await findPaymentByKey(a.dataSource, 'loc99-e9-old')
    const newer = await findPaymentByKey(a.dataSource, 'loc99-e9-new')

    await sweepAfter(b, older.id, TWO_HOURS_MS)
    await sweepAfter(b, newer.id, TWO_HOURS_MS)

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await statusOf(a.dataSource, newer.id)).toBe(PaymentStatus.REFUNDED)
    expect(await subscription()).toBeNull()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })
})
