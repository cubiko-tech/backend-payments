import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { InvoiceService } from '../src/invoice/invoice.service'
import { ProviderFactory } from '../src/provider/provider.factory'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import { Wallet } from '../src/wallet/entities/wallet.entity'
import {
  paymentRow,
  refundAudits,
  seedExternalPurchase,
  settleBrand,
  subscriptionOf,
} from './support/external-purchase.fixture'
import {
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

const BRAND_ID = 'a7101001-2222-4333-8444-555555555555'
const BALANCE = 100000
const OLD_PLAN = 'dropi-roax'
const NEW_PLAN = 'dropi-roax-plus'
const TEN_MINUTES_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

describe('An external purchase confirmed late against a newer one (PostgreSQL, LOC-101)', () => {
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

  const buy = (instance: RaceInstance, walletId: string, key: string, plan = NEW_PLAN) =>
    instance.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, plan))
  const olderExternal = () =>
    seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN, { age: '30 minutes' })
  const creditsOf = (id: string) => movements(a.dataSource, id, TransactionType.CREDIT)
  const lastRolesPlan = (instance: RaceInstance) =>
    instance.assignPlan.mock.calls[instance.assignPlan.mock.calls.length - 1][1]

  /** E1: the wallet purchase already closed when the older external one is confirmed. */
  const lateAfterWalletPurchase = async () => {
    const external = await olderExternal()
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buy(a, wallet.id, 'e1-wallet')
    return { external, wallet, newer: await findPaymentByKey(a.dataSource, 'e1-wallet') }
  }

  it('E1 keeps the newer plan and credits the older external purchase to the wallet', async () => {
    // R15: red if the external close never loses: the old plan and lastPaymentId move again.
    const { external, wallet, newer } = await lateAfterWalletPurchase()
    a.assignPlan.mockClear()

    await a.checkout.completeExternalPayment(external.id, { source: 'webhook' })

    const sub = (await subscriptionOf(a.dataSource, BRAND_ID))!
    expect(sub.planSlug).toBe(NEW_PLAN)
    expect(sub.lastPaymentId).toBe(newer.id)
    expect(Math.round((new Date(sub.currentPeriodEnd).getTime() - Date.now()) / DAY_MS)).toBe(30)
    expect(await statusOf(a.dataSource, newer.id)).toBe(PaymentStatus.COMPLETED)
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
    expect(a.assignPlan).not.toHaveBeenCalled()
    expect(await refundAudits(a.dataSource, external.id)).toBe(1)
  })

  it('E1 answers the return page with a terminal status and says it went to the wallet', async () => {
    // R15: red if reconcilePayment answers completed for a purchase that lost.
    const { external } = await lateAfterWalletPurchase()
    await a.dataSource.query('UPDATE payments SET "providerPaymentId" = $2 WHERE id = $1', [
      external.id,
      'stripe-e1',
    ])
    const providers = a.moduleRef.get(ProviderFactory) as any
    // R17: The provider is a third party; only its answer matters to this case.
    providers.getProvider.mockReturnValue({
      getPaymentStatus: jest.fn().mockResolvedValue({ status: 'completed' }),
    })

    const first = await a.checkout.reconcilePayment(external.id)
    const repeated = await a.checkout.reconcilePayment(external.id)

    expect(first).toEqual({ status: 'failed', refundedToWallet: true })
    expect(repeated).toEqual({ status: 'failed', refundedToWallet: true })
    expect(await creditsOf(external.id)).toHaveLength(1)
  })

  it('E2 ignores a repeated webhook on a refunded purchase even without a conflict left', async () => {
    // R15: red without the refunded exit of completeExternalPayment: a second refund audit.
    const { external, wallet } = await lateAfterWalletPurchase()
    await a.checkout.completeExternalPayment(external.id, { source: 'webhook' })
    await buy(a, wallet.id, 'e2-same-plan', OLD_PLAN)
    const rebought = await findPaymentByKey(a.dataSource, 'e2-same-plan')

    await a.checkout.completeExternalPayment(external.id, { source: 'duplicate' })

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect(await refundAudits(a.dataSource, external.id)).toBe(1)
    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.lastPaymentId).toBe(rebought.id)
  })

  it('E3 credits and audits once with two instances confirming at once', async () => {
    // R15: red without the payment lock of the settlement: the second one does not wait.
    const { external } = await lateAfterWalletPurchase()
    const gate = createGate()
    parkFirstCall(a.wallet, 'credit', gate)

    const first = a.checkout.completeExternalPayment(external.id, { source: 'webhook' })
    await gate.reached
    const second = b.checkout.completeExternalPayment(external.id, { source: 'webhook' })

    expect(await someoneWaitsOnAdvisoryLock(a.dataSource)).toBe(true)
    gate.release()
    await Promise.all([first, second])

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect(await refundAudits(a.dataSource, external.id)).toBe(1)
  })

  it('E4 creates the internal wallet of a brand without one and credits it', async () => {
    // R15: red if resolveRefundWallet does not create: no wallet, no credit, still processing.
    const external = await olderExternal()
    const newerExternal = await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN, {
      age: '5 minutes',
    })
    await a.checkout.completeExternalPayment(newerExternal.id, { source: 'webhook' })

    await a.checkout.completeExternalPayment(external.id, { source: 'webhook' })

    const wallets = await a.dataSource.getRepository(Wallet).findBy({ brandId: BRAND_ID })
    expect(wallets).toHaveLength(1)
    expect(wallets[0].provider).toBe('internal')
    expect(Number(wallets[0].balance)).toBe(PLAN_PRICE)
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.planSlug).toBe(NEW_PLAN)
  })

  it('E6 lets the newer external win over an older wallet purchase debited and not closed', async () => {
    // R15: red if the wallet close ignores the newer external: it closes on top and keeps the money.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    parkFirstCall(a.checkout, 'closeWalletPayment', gate)
    const older = buy(a, wallet.id, 'e6-wallet', OLD_PLAN)
    await gate.reached
    const external = await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN)

    await b.checkout.completeExternalPayment(external.id, { source: 'webhook' })
    gate.release()
    await expect(older).rejects.toThrow('closed by another process')
    jest.restoreAllMocks()
    const walletPayment = await findPaymentByKey(a.dataSource, 'e6-wallet')
    await sweepAfter(a, walletPayment.id, TEN_MINUTES_MS)

    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.planSlug).toBe(NEW_PLAN)
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.COMPLETED)
    expect(await statusOf(a.dataSource, walletPayment.id)).toBe(PaymentStatus.REFUNDED)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('E7 hands back an older wallet purchase that overlapped and the sweep credits it', async () => {
    // R15: red if the external close does not yield overlapped purchases: wallet stays completed.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buy(a, wallet.id, 'e7-wallet', OLD_PLAN)
    const older = await findPaymentByKey(a.dataSource, 'e7-wallet')
    const external = await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN, {
      age: '5 minutes',
    })
    await a.dataSource.query(
      `UPDATE payments SET "createdAt" = NOW() - INTERVAL '10 minutes' WHERE id = $1`,
      [older.id],
    )

    await a.checkout.completeExternalPayment(external.id, { source: 'webhook' })

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.PROCESSING)
    await sweepAfter(a, older.id, TEN_MINUTES_MS)
    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.lastPaymentId).toBe(external.id)
    expect(lastRolesPlan(a)).toBe(NEW_PLAN)
  })

  it('E8 credits the older external when a newer wallet purchase is debited and not closed', async () => {
    // R15: red without hasNewerDebitedPurchase: the external applies and then gets overwritten.
    const external = await olderExternal()
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    parkFirstCall(a.checkout, 'closeWalletPayment', gate)
    const newer = buy(a, wallet.id, 'e8-wallet')
    await gate.reached

    await b.checkout.completeExternalPayment(external.id, { source: 'webhook' })

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await subscriptionOf(a.dataSource, BRAND_ID)).toBeNull()
    gate.release()
    await newer
    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.planSlug).toBe(NEW_PLAN)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(BALANCE)
  })

  it('E9 hands back a completed external purchase and its own sweep credits it', async () => {
    // R15: red if the yield is wallet only, or the sweep skips purchases handed back with paidAt.
    const external = await olderExternal()
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    parkFirstCall(a.wallet, 'debit', gate)
    const newer = buy(a, wallet.id, 'e9-wallet')
    await gate.reached
    await b.checkout.completeExternalPayment(external.id, { source: 'webhook' })
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.COMPLETED)

    gate.release()
    await newer
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.PROCESSING)

    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.planSlug).toBe(NEW_PLAN)
  })

  it('E10 leaves roles on the newer plan when the older one answers last', async () => {
    // R15: red if the external path sends once without reading again: roles ends on the old plan.
    const external = await olderExternal()
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const answered: string[] = []
    const gate = createGate()
    const record = async (_brand: string, plan: string) => {
      answered.push(plan)
    }
    // R17: backend-roles is HTTP; the order of its answers is what this case forces.
    a.assignPlan
      .mockImplementationOnce(async (brand: string, plan: string) => {
        gate.arrive()
        await gate.wait
        await record(brand, plan)
      })
      .mockImplementationOnce(record)
    b.assignPlan.mockImplementationOnce(record)
    const confirming = a.checkout.completeExternalPayment(external.id, { source: 'webhook' })
    await gate.reached

    await buy(b, wallet.id, 'e10-roles-wallet')
    gate.release()
    await confirming
    a.assignPlan.mockReset()

    expect(answered[answered.length - 1]).toBe(NEW_PLAN)
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
  })

  it('E10 credits the external purchase that a newer one beat during its invoice calls', async () => {
    // R15: red if the last step does not judge again: completed with no days left.
    const external = await olderExternal()
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    const invoices = a.moduleRef.get(InvoiceService) as any
    // R17: Holding the invoice call open is the only way to provoke this window on demand.
    invoices.create.mockImplementationOnce(async () => {
      gate.arrive()
      await gate.wait
      return { data: { id: 'inv-e10', invoiceNumber: 'CK-E10' } }
    })
    const confirming = a.checkout.completeExternalPayment(external.id, { source: 'webhook' })
    await gate.reached

    await buy(a, wallet.id, 'e10-wallet')
    gate.release()
    await confirming

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect(lastRolesPlan(a)).toBe(NEW_PLAN)
  })

  it('E11 keeps a plain plan change: a purchase paid before the newer one existed is not credited', async () => {
    // R15: red if the yield ignores the overlap: the older one is handed back and credited.
    const external = await olderExternal()
    await a.checkout.completeExternalPayment(external.id, { source: 'webhook' })
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)

    await buy(a, wallet.id, 'e11-wallet')

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(external.id)).toHaveLength(0)
    expect(
      (await paymentRow(a.dataSource, external.id)).metadata?.lostToNewerPurchase,
    ).toBeUndefined()
    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.planSlug).toBe(NEW_PLAN)
  })
})
