import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  backdateEvent,
  seedExternalPurchase,
  settleBrand,
  subscriptionOf,
} from './support/external-purchase.fixture'
import {
  balanceOf,
  cleanBrand,
  createGate,
  findPaymentByKey,
  Gate,
  movements,
  parkFirstCall,
  PLAN_PRICE,
  planCheckout,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
  sweepAfter,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7103001-2222-4333-8444-555555555555'
const BALANCE = 100000
const OLD_PLAN = 'dropi-roax'
const NEW_PLAN = 'dropi-roax-plus'
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

/** The 15-minute limit on every path that reads it; the clock is the only thing written by hand. */
describe('Window to hand back a purchase already applied (PostgreSQL, LOC-103)', () => {
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

  const confirm = (id: string) => a.checkout.completeExternalPayment(id, { source: 'webhook' })
  const creditsOf = (id: string) => movements(a.dataSource, id, TransactionType.CREDIT)
  const subscription = async () => (await subscriptionOf(a.dataSource, BRAND_ID))!

  /** The older purchase applied `age` ago, the newer was already open then and confirms now. */
  const externalDisplacedAfter = async (age: string) => {
    const older = await seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN, {
      age: '40 minutes',
    })
    const newer = await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN, {
      age: '30 minutes',
    })
    await confirm(older.id)
    await a.dataSource.query(
      `UPDATE payments SET "paidAt" = NOW() - INTERVAL '${age}' WHERE id = $1`,
      [older.id],
    )
    await backdateEvent(a.dataSource, older.id, age)
    await confirm(newer.id)
    return { older, newer }
  }

  it('hands back an external purchase displaced at 14 minutes', async () => {
    // R15: red if the window drops under 14 minutes: the purchase keeps its charge.
    const { older, newer } = await externalDisplacedAfter('14 minutes')

    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(older.id)).toHaveLength(1)
    expect((await subscription()).lastPaymentId).toBe(newer.id)
  })

  it('keeps the charge of an external purchase displaced at 16 minutes', async () => {
    // R15: red if the window goes back to 24 hours: the purchase is handed back and credited.
    const { older, newer } = await externalDisplacedAfter('16 minutes')

    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(older.id)).toHaveLength(0)
    expect((await subscription()).lastPaymentId).toBe(newer.id)
  })

  it('credits at settlement a purchase handed back in time, although the window passed since', async () => {
    // R15: red if the sweep judges the window again: handed back and never credited.
    const { older } = await externalDisplacedAfter('14 minutes')
    await backdateEvent(a.dataSource, older.id, '16 minutes')

    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(older.id)).toHaveLength(1)
  })

  /** Both debited: the older one closes first, applied `age` ago, and then the newer one closes. */
  const walletDisplacedAfter = async (age: string) => {
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const olderGate: Gate = createGate()
    // The older one parks past its superseded check, so the newer debit does not make it lose.
    parkFirstCall(a.checkout, 'createOrRenewSubscription', olderGate)
    const olderRun = a.checkout.processCheckout(
      planCheckout(BRAND_ID, wallet.id, 'window-older', OLD_PLAN),
    )
    await olderGate.reached
    const newerGate: Gate = createGate()
    parkFirstCall(b.checkout, 'closeWalletPayment', newerGate)
    const newerRun = b.checkout.processCheckout(
      planCheckout(BRAND_ID, wallet.id, 'window-newer', NEW_PLAN),
    )
    await newerGate.reached
    olderGate.release()
    await olderRun
    const older = await findPaymentByKey(a.dataSource, 'window-older')
    await backdateEvent(a.dataSource, older.id, age)
    newerGate.release()
    await newerRun
    await sweepAfter(b, older.id, TWO_HOURS_MS)
    return { older, wallet }
  }

  it('hands back a wallet purchase displaced at 14 minutes', async () => {
    // R15: red if the window drops under 14 minutes: both purchases stay charged.
    const { older, wallet } = await walletDisplacedAfter('14 minutes')

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(older.id)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - PLAN_PRICE)
  })

  it('keeps the charge of a wallet purchase displaced at 16 minutes', async () => {
    // R15: red if the window goes back to 24 hours: the used purchase is credited in full.
    const { older, wallet } = await walletDisplacedAfter('16 minutes')

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(older.id)).toHaveLength(0)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE - 2 * PLAN_PRICE)
  })

  /** Applied and stuck `age` before another purchase changes its plan, which just happened. */
  const stuckDisplacedAfter = async (age: string) => {
    const stuck = await seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN, {
      age: '40 minutes',
    })
    const invoices = a.moduleRef.get(InvoiceService) as any
    // R17: A crash between applying the plan and completing cannot be provoked on demand.
    invoices.create.mockRejectedValueOnce(new Error('Invoice crash'))
    await expect(confirm(stuck.id)).rejects.toThrow('Invoice crash')
    const newer = await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN, {
      age: '30 minutes',
    })
    await confirm(newer.id)
    await backdateEvent(a.dataSource, stuck.id, age)
    await settleBrand(a, BRAND_ID)
    return stuck
  }

  it('credits a purchase stuck after applying whose plan changed at 14 minutes', async () => {
    // R15: red if the window drops under 14 minutes: it completes with its plan replaced.
    const stuck = await stuckDisplacedAfter('14 minutes')

    expect(await statusOf(a.dataSource, stuck.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(stuck.id)).toHaveLength(1)
  })

  it('completes a purchase stuck after applying whose plan changed at 16 minutes', async () => {
    // R15: red if the window goes back to 24 hours: it is credited after 16 minutes of use.
    const stuck = await stuckDisplacedAfter('16 minutes')

    expect(await statusOf(a.dataSource, stuck.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(stuck.id)).toHaveLength(0)
    expect((await subscription()).planSlug).toBe(NEW_PLAN)
  })
})
