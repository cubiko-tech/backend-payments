import { AuditService } from '../src/audit/audit.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import {
  paymentRow,
  seedExternalPurchase,
  subscriptionOf,
} from './support/external-purchase.fixture'
import {
  cleanBrand,
  createGate,
  findPaymentByKey,
  movements,
  parkFirstCall,
  planCheckout,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7101002-2222-4333-8444-555555555555'
const BALANCE = 100000
const OLD_PLAN = 'dropi-roax'
const NEW_PLAN = 'dropi-roax-plus'

describe('Settling an external purchase that lost to a newer one (PostgreSQL, LOC-101)', () => {
  let a: RaceInstance

  beforeAll(async () => {
    a = await startInstance()
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND_ID))

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
  })

  const buy = (walletId: string, key: string, plan = NEW_PLAN) =>
    a.checkout.processCheckout(planCheckout(BRAND_ID, walletId, key, plan))
  const olderExternal = (options = {}) =>
    seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN, { age: '30 minutes', ...options })
  const creditsOf = (id: string) => movements(a.dataSource, id, TransactionType.CREDIT)
  const setWalletStatus = (id: string, status: WalletStatus) =>
    a.dataSource.getRepository(Wallet).update({ id }, { status })
  const confirm = (id: string) => a.checkout.completeExternalPayment(id, { source: 'webhook' })

  /** A newer wallet purchase closes, then the wallet closes too: the loser cannot be credited. */
  const lostWithClosedWallet = async (options = {}) => {
    const external = await olderExternal(options)
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buy(wallet.id, 'closed-newer')
    await setWalletStatus(wallet.id, WalletStatus.CLOSED)
    await confirm(external.id)
    return { external, wallet }
  }

  /** Plan applied and the confirmation died in the invoice, so the purchase stays `processing`. */
  const appliedWithoutCompleting = async (externalId: string) => {
    const invoices = a.moduleRef.get(InvoiceService) as any
    // R17: A crash between applying the plan and completing cannot be provoked on demand.
    invoices.create.mockRejectedValueOnce(new Error('Invoice crash'))
    await expect(confirm(externalId)).rejects.toThrow('Invoice crash')
    expect(await statusOf(a.dataSource, externalId)).toBe(PaymentStatus.PROCESSING)
  }

  it('E5 leaves it flagged and uncredited with a closed wallet, and answers processing', async () => {
    // R15: red if the close does not flag the loser: a later pass could not tell it lost.
    const { external } = await lostWithClosedWallet()

    const row = await paymentRow(a.dataSource, external.id)
    expect(row.status).toBe(PaymentStatus.PROCESSING)
    expect(row.metadata.lostToNewerPurchase).toBe(true)
    expect(await creditsOf(external.id)).toHaveLength(0)
    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.planSlug).toBe(NEW_PLAN)
    expect(await a.checkout.reconcilePayment(external.id)).toEqual({ status: 'processing' })
  })

  it('E5 credits it from the sweep once the wallet can take it, even without a conflict left', async () => {
    // R15: red if the flag stops deciding: with its plan current again it applies a free plan.
    const { external, wallet } = await lostWithClosedWallet()
    await setWalletStatus(wallet.id, WalletStatus.ACTIVE)
    await buy(wallet.id, 'closed-same-plan', OLD_PLAN)

    await a.tasks.settleLostExternalPayments()

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    const rebought = await findPaymentByKey(a.dataSource, 'closed-same-plan')
    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.lastPaymentId).toBe(rebought.id)
  })

  it('E13 credits a purchase that applied, lost its plan and saw that plan bought again', async () => {
    // R15: red without planMovedAfter: completed and charged, with the days of another purchase.
    const external = await olderExternal()
    await appliedWithoutCompleting(external.id)
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buy(wallet.id, 'moved-other')
    await buy(wallet.id, 'moved-back', OLD_PLAN)

    await confirm(external.id)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
  })

  it('E14 does not credit an applied purchase for a newer debit that has not closed', async () => {
    // R15: red if an applied purchase loses to the open debit: credited and it keeps the plan.
    const external = await olderExternal()
    await appliedWithoutCompleting(external.id)
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    const gate = createGate()
    parkFirstCall(a.checkout, 'closeWalletPayment', gate)
    const newer = buy(wallet.id, 'applied-newer')
    await gate.reached

    await a.checkout.completeExternalPayment(external.id, { source: 'retry' })

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.COMPLETED)
    expect(await creditsOf(external.id)).toHaveLength(0)

    gate.release()
    await newer
    await a.tasks.settleLostExternalPayments()

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect((await subscriptionOf(a.dataSource, BRAND_ID))!.planSlug).toBe(NEW_PLAN)
  })

  it('E15 keeps the lost flag against a confirmation that read the row before it was set', async () => {
    // R15: red without the guard of the claim: the stale metadata erases the flag.
    const { external, wallet } = await lostWithClosedWallet()
    await setWalletStatus(wallet.id, WalletStatus.ACTIVE)
    await buy(wallet.id, 'stale-same-plan', OLD_PLAN)
    const stale = await paymentRow(a.dataSource, external.id)
    delete stale.metadata.lostToNewerPurchase
    // R17: Only a forced stale read provokes this interleaving on demand.
    jest.spyOn((a.checkout as any).paymentRepo, 'findOne').mockResolvedValueOnce(stale)

    await confirm(external.id)

    const row = await paymentRow(a.dataSource, external.id)
    expect(row.metadata.lostToNewerPurchase).toBe(true)
    const applied = await a.dataSource
      .getRepository(SubscriptionEvent)
      .countBy({ paymentId: external.id })
    expect(applied).toBe(0)
  })

  it('E16 finishes a credit already made although the wallet closed after it', async () => {
    // R15: red if the refund check runs after resolving the wallet: stuck with the money back.
    const external = await olderExternal()
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buy(wallet.id, 'crash-newer')
    // R17: A crash between the credit and the status cannot be provoked on demand.
    jest.spyOn(a.moduleRef.get(AuditService), 'log').mockRejectedValueOnce(new Error('Crash'))
    await expect(confirm(external.id)).rejects.toThrow('Crash')
    expect(await creditsOf(external.id)).toHaveLength(1)
    await setWalletStatus(wallet.id, WalletStatus.CLOSED)

    await confirm(external.id)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
  })

  /** A newer external purchase wins, and the brand has no `internal` wallet to credit. */
  const lostWithoutWallet = async () => {
    const external = await olderExternal()
    const newer = await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN, { age: '5 minutes' })
    await confirm(newer.id)
    return external
  }

  it('E17 does not throw when the brand is at its wallet limit', async () => {
    // R15: red without the catch of resolveRefundWallet: MAX_WALLETS reaches the provider.
    const external = await lostWithoutWallet()
    const repo = a.dataSource.getRepository(Wallet)
    const seeds = Array.from({ length: 10 }, (_, index) => ({
      brandId: BRAND_ID,
      userId: BRAND_ID,
      provider: `other-${index}`,
      currency: 'COP',
      balance: 0,
    }))
    await repo.save(seeds.map((seed) => repo.create(seed)))

    await expect(confirm(external.id)).resolves.toBeUndefined()

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.PROCESSING)
    expect(await creditsOf(external.id)).toHaveLength(0)
  })

  it('E18 does not credit when creating the wallet answers an error', async () => {
    // R15: red if the error answer is not reported: the purchase is stuck with nothing logged.
    const external = await lostWithoutWallet()
    // R17: The error log is the only signal that a person has to act on this purchase.
    const logged = jest.spyOn((a.checkout as any).log, 'error')
    // R17: A failing insert is a database failure that cannot be provoked on demand.
    jest.spyOn(a.wallet, 'create').mockResolvedValueOnce({ error: 'Insert failed' })

    await expect(confirm(external.id)).resolves.toBeUndefined()

    expect(logged).toHaveBeenCalledWith(expect.stringContaining('Insert failed'))

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.PROCESSING)
    expect(await creditsOf(external.id)).toHaveLength(0)
  })

  const replay = (key: string) =>
    a.checkout.processCheckout({
      brandId: BRAND_ID,
      userId: 'user-loc101',
      provider: 'stripe',
      purpose: 'plan_purchase',
      planSlug: OLD_PLAN,
      idempotencyKey: key,
    })

  it('E19 answers 409 to the same key on a lost purchase still without its credit', async () => {
    // R15: red without the flag in the idempotency guard: it replays the stored pending result.
    const { external } = await lostWithClosedWallet({ idempotencyKey: 'lost-key' })
    await a.dataSource.query(
      `UPDATE payments SET metadata = metadata || '{"checkoutResult":{"status":"pending"}}' WHERE id = $1`,
      [external.id],
    )

    await expect(replay('lost-key')).rejects.toMatchObject({ status: 409 })
  })

  it('E20 answers its status without a checkout URL to the same key on a refunded purchase', async () => {
    // R15: red if a refunded purchase replays its result: the buyer is sent back to pay.
    const external = await olderExternal({
      idempotencyKey: 'refunded-key',
      checkoutUrl: 'https://pay/e20',
    })
    await a.dataSource.query(
      `UPDATE payments SET metadata = metadata || '{"checkoutResult":{"status":"pending"}}' WHERE id = $1`,
      [external.id],
    )
    const wallet = await seedWallet(a.dataSource, BRAND_ID, BALANCE)
    await buy(wallet.id, 'refunded-newer')
    await confirm(external.id)

    const answer = await replay('refunded-key')

    expect(answer).toEqual({ paymentId: external.id, status: PaymentStatus.REFUNDED })
  })
})
