/**
 * Refunding a token package end to end on PostgreSQL: approving takes back the purchased tokens
 * and the bonus the package credited, once and in the approving transaction; a package whose
 * tokens are gone, or a partial refund, is refused with nothing moved. Plan and recharge refunds
 * keep working as before.
 */
import { config as dotenvConfig } from 'dotenv'
import { DataSource, EntityManager } from 'typeorm'

import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { Refund, RefundReason, RefundStatus } from '../src/refund/entities/refund.entity'
import { RefundService } from '../src/refund/refund.service'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet } from '../src/wallet/entities/wallet.entity'
import { TokenOrigin } from '../src/wallet/token-origin'
import { refundTokensKey } from '../src/wallet/token-package-reclaim'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import {
  cleanPackageBrand,
  confioNotice,
  fakeExternalProvider,
  packageCheckout,
  packageId,
  tokenWalletOf,
} from './support/token-package.fixture'
import { TrmSource, startTrmSource, trmOk } from './support/trm-source.fixture'
import {
  RaceInstance,
  raceConnectionOptions,
  sessionsWaitOnRowLock,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'b1610000-0000-4000-8000-000000000161'
const COP_PRICE = 100000 // USD 25 at the source's TRM of 4000
const ADMIN = 'superadmin-loc161'
const INTACT = ['27.00', '25.00', '2.00']

describe('Refunding a token package (PostgreSQL, LOC-161)', () => {
  let source: TrmSource
  let instance: RaceInstance
  let id: string
  let refunds: RefundService
  let otherRefunds: RefundService
  const refundSources: DataSource[] = []

  // Each one is its own pool, as two service instances would be.
  const startRefundService = async () => {
    const entities = [Refund, Payment, Wallet, Transaction]
    const dataSource = new DataSource({ ...raceConnectionOptions(), entities })
    await dataSource.initialize()
    refundSources.push(dataSource)
    const repo = dataSource.getRepository(Refund)
    return new RefundService(repo, repo, dataSource.getRepository(Payment))
  }
  const cleanRefunds = () =>
    instance.dataSource.query('DELETE FROM refunds WHERE "brandId" = $1', [BRAND])
  const tokens = () => instance.moduleRef.get(TokenWalletService)

  const boughtPackage = async () => {
    const checkout = await instance.checkout.processCheckout(packageCheckout(BRAND, id))
    await instance.checkout.completeExternalPayment(checkout.paymentId, confioNotice(COP_PRICE))
    return instance.dataSource.getRepository(Payment).findOneByOrFail({ id: checkout.paymentId })
  }
  const ask = (payment: Payment, amount = Number(payment.amount)) =>
    refunds.request({
      brandId: BRAND,
      paymentId: payment.id,
      amount,
      currency: payment.currency,
      reason: RefundReason.CUSTOMER_REQUEST,
      requestedBy: 'user-loc161',
    })
  const pendingRefund = async (payment: Payment) => (await ask(payment)).data!
  const spend = (walletId: string, amount: number) =>
    tokens().debitTokens(walletId, amount, { brandId: BRAND })
  const walletState = async () => {
    const wallet = (await tokenWalletOf(instance.dataSource, BRAND))!
    return [wallet.balance, wallet.purchasedTokens, wallet.giftTokens]
  }
  const refundStatuses = async (paymentId: string) =>
    (
      await instance.dataSource.query('SELECT status FROM refunds WHERE "paymentId" = $1', [
        paymentId,
      ])
    ).map((r: { status: string }) => r.status)
  const refundDebits = (refundId: string) =>
    instance.dataSource
      .getRepository(Transaction)
      .findBy({ referenceType: 'refund', referenceId: refundId })

  beforeAll(async () => {
    source = await startTrmSource()
    instance = await startInstance({ realBilling: true, trmUrl: source.url })
    id = await packageId(instance.dataSource)
    refunds = await startRefundService()
    otherRefunds = await startRefundService()
  })

  beforeEach(async () => {
    await cleanRefunds()
    await cleanPackageBrand(instance.dataSource, BRAND)
    source.reply = trmOk
    fakeExternalProvider(instance)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanRefunds()
    await cleanPackageBrand(instance.dataSource, BRAND)
    for (const dataSource of refundSources) await dataSource.destroy()
    await stopInstance(instance)
    await source.close()
  })

  it('CA3 approving an intact package takes 25 purchased and 2 gift in one debit of the refund', async () => {
    // R15: red when approve stops reclaiming the package tokens: purchased stays at 25.00.
    const payment = await boughtPackage()
    const refund = await pendingRefund(payment)

    const approved = await refunds.approve(refund.id, ADMIN)

    expect(approved.data!.status).toBe(RefundStatus.PROCESSING)
    expect(await walletState()).toEqual(['0.00', '0.00', '0.00'])
    const debits = await refundDebits(refund.id)
    expect(debits).toHaveLength(1)
    expect(debits[0].amount).toBe('27.00')
    expect(debits[0].metadata.tokenSplit).toEqual({ gift: 2, purchased: 25, dropi: 0 })
  })

  it('CA3 two approvals at once from two instances: one processes, the other gets 422', async () => {
    // R15: red when approve reads the refund without its lock: the second gets TOKENS_SPENT.
    const payment = await boughtPackage()
    const refund = await pendingRefund(payment)
    const outcome = (approval: Promise<{ data?: Refund }>) =>
      approval.then(
        (r) => r.data!.status,
        (e) => e.code,
      )

    // Holds the wallet until both approvals are blocked, so they really overlap.
    const holder = instance.dataSource.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    let approvals: Promise<string>[] = []
    try {
      await holder.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [payment.walletId])
      approvals = [
        outcome(refunds.approve(refund.id, ADMIN)),
        outcome(otherRefunds.approve(refund.id, ADMIN)),
      ]
      expect(await sessionsWaitOnRowLock(instance.dataSource, 2)).toBe(true)
    } finally {
      await holder.rollbackTransaction()
      await holder.release()
    }

    expect((await Promise.all(approvals)).sort()).toEqual(['REFUND_NOT_PENDING', 'processing'])
    expect(await refundDebits(refund.id)).toHaveLength(1)
  })

  it('CA3 refuses to request a package with 10 tokens spent: 422 and no refund saved', async () => {
    // R15: red when request skips the tokens check: a pending refund row is saved.
    const payment = await boughtPackage()
    await spend(payment.walletId, 10)

    await expect(ask(payment)).rejects.toMatchObject({
      status: 422,
      code: 'TOKEN_PACKAGE_TOKENS_SPENT',
    })
    expect(await refundStatuses(payment.id)).toEqual([])
    expect(await walletState()).toEqual(['17.00', '17.00', '0.00'])
  })

  it('CA3 refuses to approve when 10 tokens were spent after the request: stays pending', async () => {
    // R15: red when reclaimPackageTokens skips its own check: the refund is approved.
    const payment = await boughtPackage()
    const refund = await pendingRefund(payment)
    await spend(payment.walletId, 10)

    await expect(refunds.approve(refund.id, ADMIN)).rejects.toMatchObject({
      status: 422,
      code: 'TOKEN_PACKAGE_TOKENS_SPENT',
    })
    expect(await refundStatuses(payment.id)).toEqual([RefundStatus.PENDING])
    expect(await walletState()).toEqual(['17.00', '17.00', '0.00'])
  })

  it('CA3 refuses a partial refund of an intact package with 422 and saves nothing', async () => {
    // R15: red when request skips the full-amount check: a pending refund row is saved.
    const payment = await boughtPackage()

    await expect(ask(payment, 40000)).rejects.toMatchObject({
      status: 422,
      code: 'TOKEN_PACKAGE_PARTIAL_REFUND',
    })
    expect(await refundStatuses(payment.id)).toEqual([])
    expect(await walletState()).toEqual(INTACT)
  })

  it('CA3 refuses to approve a pending partial refund of a package: 422 and nothing moves', async () => {
    // R15: red when approve skips the full-amount check: processing and the wallet at 0.00.
    const payment = await boughtPackage()
    const repo = refundSources[0].getRepository(Refund)
    // Saved directly, as a partial request accepted before request() refused them.
    const refund = await repo.save(
      repo.create({
        brandId: BRAND,
        paymentId: payment.id,
        amount: 10,
        currency: payment.currency,
        reason: RefundReason.CUSTOMER_REQUEST,
        requestedBy: 'user-loc161',
        status: RefundStatus.PENDING,
      }),
    )

    await expect(refunds.approve(refund.id, ADMIN)).rejects.toMatchObject({
      status: 422,
      code: 'TOKEN_PACKAGE_PARTIAL_REFUND',
    })
    expect(await refundStatuses(payment.id)).toEqual([RefundStatus.PENDING])
    expect(await walletState()).toEqual(INTACT)
    expect(await refundDebits(refund.id)).toHaveLength(0)
  })

  it.each([PaymentPurpose.PLAN_PURCHASE, PaymentPurpose.WALLET_RECHARGE])(
    'CA3 a %s refund is approved as before and moves no token wallet',
    async (purpose) => {
      // R15: red when approve reclaims for every purpose: 422 instead of processing.
      await boughtPackage()
      const repo = instance.dataSource.getRepository(Payment)
      const payment = await repo.save(
        repo.create({
          brandId: BRAND,
          userId: 'user-loc161',
          provider: PaymentProvider.WALLET,
          amount: 5000,
          currency: 'COP',
          status: PaymentStatus.COMPLETED,
          purpose,
          purposeId: 'pro',
        }),
      )
      const refund = await pendingRefund(payment)

      const approved = await refunds.approve(refund.id, ADMIN)

      expect(approved.data!.status).toBe(RefundStatus.PROCESSING)
      expect(await walletState()).toEqual(INTACT)
      expect(await refundDebits(refund.id)).toHaveLength(0)
    },
  )

  it('CA3 takes the bonus from gift and the paid tokens from purchased, not gift first', async () => {
    // R15: red when the reclaim draws gift first: gift ends at 0.00 and purchased at 5.00.
    const payment = await boughtPackage()
    await tokens().creditTokens(payment.walletId, 5, TokenOrigin.GIFT, { brandId: BRAND })
    const refund = await pendingRefund(payment)

    await refunds.approve(refund.id, ADMIN)

    expect(await walletState()).toEqual(['5.00', '0.00', '5.00'])
  })

  it('CA3 refuses to approve once the token wallet is closed: stays pending', async () => {
    // R15: red when holdsPackageTokens ignores a closed wallet: the refund is approved.
    const payment = await boughtPackage()
    const refund = await pendingRefund(payment)
    await instance.dataSource.query(`UPDATE wallets SET status = 'closed' WHERE id = $1`, [
      payment.walletId,
    ])

    await expect(refunds.approve(refund.id, ADMIN)).rejects.toMatchObject({
      status: 422,
      code: 'TOKEN_PACKAGE_TOKENS_SPENT',
    })
    expect(await refundStatuses(payment.id)).toEqual([RefundStatus.PENDING])
    expect(await walletState()).toEqual(INTACT)
  })

  it('a failure saving the approval rolls back the debit and is not answered as a success', async () => {
    // R15: red when the reclaim commits on its own runner: the wallet ends at 0.00.
    const payment = await boughtPackage()
    const refund = await pendingRefund(payment)
    const save = EntityManager.prototype.save
    // R17: forces a write failure after the debit, which PostgreSQL does not give on demand.
    jest.spyOn(EntityManager.prototype, 'save').mockImplementation(function (this: any, ...args) {
      if (args[0] === Refund) return Promise.reject(new Error('refund store down'))
      return (save as any).apply(this, args)
    })

    await expect(refunds.approve(refund.id, ADMIN)).rejects.toThrow('refund store down')
    jest.restoreAllMocks()

    expect(await refundStatuses(payment.id)).toEqual([RefundStatus.PENDING])
    expect(await walletState()).toEqual(INTACT)
    expect(await refundDebits(refund.id)).toHaveLength(0)
  })

  it('a debit already keyed by the refund answers 422 REFUND_NOT_PENDING and moves nothing', async () => {
    // R15: red when approve stops translating the key violation: it rejects without a code.
    const payment = await boughtPackage()
    const refund = await pendingRefund(payment)
    const key = refundTokensKey(refund.id)
    await tokens().creditTokens(payment.walletId, 1, TokenOrigin.GIFT, { brandId: BRAND }, key)

    await expect(refunds.approve(refund.id, ADMIN)).rejects.toMatchObject({
      status: 422,
      code: 'REFUND_NOT_PENDING',
    })
    expect(await refundStatuses(payment.id)).toEqual([RefundStatus.PENDING])
    expect(await walletState()).toEqual(['28.00', '25.00', '3.00'])
  })
})
