/**
 * Buying a token package end to end on PostgreSQL: the price and the tokens come from the
 * catalog, a Colombian brand pays in COP at the TRM (a local HTTP source), the invoice carries
 * the VAT included in what was paid, and completion credits purchased and bonus tokens once.
 */
import { config as dotenvConfig } from 'dotenv'

import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { TokenPackage } from '../src/wallet/entities/token-package.entity'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import {
  cleanPackageBrand,
  dropiNotice,
  fakeDropi,
  packageCheckout,
  packageId,
  paymentsOf,
  TESTEO_SEMANAL,
  tokenWalletOf,
} from './support/token-package.fixture'
import { TrmSource, startTrmSource, trmDown, trmOk } from './support/trm-source.fixture'
import {
  createGate,
  parkFirstCall,
  RaceInstance,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'b1360000-0000-4000-8000-000000000136'
const COP_PRICE = 100000 // USD 25 at the source's TRM of 4000

describe('Buying a token package (PostgreSQL, LOC-136)', () => {
  let source: TrmSource
  let instance: RaceInstance
  let id: string

  const tokenMoves = async () => {
    const wallet = await tokenWalletOf(instance.dataSource, BRAND)
    return wallet
      ? instance.dataSource.getRepository(Transaction).findBy({ walletId: wallet.id })
      : []
  }
  const invoicesOf = (paymentId: string) =>
    instance.dataSource.query(
      `SELECT i.subtotal, i."taxTotal", i.total, i.currency, it.description, it."productType"
         FROM invoices i JOIN invoice_items it ON it."invoiceId" = i.id WHERE i."paymentId" = $1`,
      [paymentId],
    )
  const buy = async (overrides = {}) =>
    (await instance.checkout.processCheckout(packageCheckout(BRAND, id, overrides))).paymentId
  const restoreCatalog = () =>
    instance.dataSource
      .getRepository(TokenPackage)
      .update({ slug: TESTEO_SEMANAL.slug }, TESTEO_SEMANAL)

  beforeAll(async () => {
    source = await startTrmSource()
    instance = await startInstance({ realBilling: true, trmUrl: source.url })
    id = await packageId(instance.dataSource)
  })

  beforeEach(async () => {
    await cleanPackageBrand(instance.dataSource, BRAND)
    await restoreCatalog()
    source.reply = trmOk
    fakeDropi(instance)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanPackageBrand(instance.dataSource, BRAND)
    await restoreCatalog()
    await stopInstance(instance)
    await source.close()
  })

  it('CA3 the USD 25 package charges COP at its TRM, invoices VAT included and credits 25 + 2', async () => {
    // R15: red when completion credits the paid amount instead of the package tokens: 100002.
    const paymentId = await buy()
    const done = await instance.checkout.completeExternalPayment(paymentId, dropiNotice(COP_PRICE))

    expect(done).toBe(true)
    const payment = (await paymentsOf(instance.dataSource, BRAND))[0]
    expect(payment).toMatchObject({
      status: PaymentStatus.COMPLETED,
      currency: 'COP',
      amount: '100000.00',
    })
    expect(payment.exchangeRate).toBe('4000.00')
    expect(payment.metadata.tokenPackage).toMatchObject({
      priceUsd: 25,
      purchasedTokens: 25,
      bonusTokens: 2,
    })
    expect(await invoicesOf(paymentId)).toEqual([
      {
        subtotal: '84033.61',
        taxTotal: '15966.39',
        total: '100000.00',
        currency: 'COP',
        description: 'Paquete de 25 tokens ROAX',
        productType: 'token_package',
      },
    ])
    const wallet = (await tokenWalletOf(instance.dataSource, BRAND))!
    expect(wallet.id).toBe(payment.walletId)
    expect([wallet.balance, wallet.purchasedTokens, wallet.giftTokens]).toEqual([
      '27.00',
      '25.00',
      '2.00',
    ])
  })

  it('CA3 charges and credits the catalog, not the price, currency or wallet in the body', async () => {
    // R15: red when the package price falls back to req.amount: the payment reads 1.00.
    const foreign = '00000000-0000-4000-8000-0000000000ff'
    const paymentId = await buy({ amount: 1, currency: 'USD', walletId: foreign })

    const payment = (await paymentsOf(instance.dataSource, BRAND))[0]
    expect([payment.amount, payment.currency]).toEqual(['100000.00', 'COP'])
    expect(payment.walletId).not.toBe(foreign)
    await instance.checkout.completeExternalPayment(paymentId, dropiNotice(COP_PRICE))
    expect((await tokenWalletOf(instance.dataSource, BRAND))!.balance).toBe('27.00')
  })

  it('two completions at once credit the tokens once: the second one does nothing', async () => {
    // R15: red when completeExternalPayment drops its inFlightCompletions guard: [false, true].
    const paymentId = await buy()
    const gate = createGate()
    parkFirstCall(instance.moduleRef.get(TokenWalletService), 'creditTokens', gate)

    const first = instance.checkout.completeExternalPayment(paymentId, dropiNotice(COP_PRICE))
    await gate.reached
    const second = await instance.checkout.completeExternalPayment(
      paymentId,
      dropiNotice(COP_PRICE),
    )
    gate.release()

    expect([await first, second]).toEqual([true, false])
    expect(await tokenMoves()).toHaveLength(2)
    expect(await invoicesOf(paymentId)).toHaveLength(1)
  })

  it('a completion that failed after crediting is completed by the sweep without crediting again', async () => {
    // R15: red when creditTokenPackage drops its purchased key: the sweep credits 25 again, 52.
    const paymentId = await buy()
    jest
      .spyOn(instance.moduleRef.get(InvoiceService), 'create')
      .mockRejectedValueOnce(new Error('invoice store down'))
    await expect(
      instance.checkout.completeExternalPayment(paymentId, dropiNotice(COP_PRICE)),
    ).rejects.toThrow('invoice store down')
    expect((await paymentsOf(instance.dataSource, BRAND))[0].status).toBe(PaymentStatus.PROCESSING)

    // The call payment-sweep.ts makes for a payment left in `processing`.
    expect(
      await instance.checkout.completeExternalPayment(paymentId, { source: 'cron-reconcile' }),
    ).toBe(true)

    expect((await paymentsOf(instance.dataSource, BRAND))[0].status).toBe(PaymentStatus.COMPLETED)
    expect((await tokenWalletOf(instance.dataSource, BRAND))!.balance).toBe('27.00')
    expect(await tokenMoves()).toHaveLength(2)
  })

  it('credits the bonus the package had when it was bought, not a later catalog edit', async () => {
    // R15: red when completion reads the catalog instead of the payment snapshot: gift reads 9.
    const paymentId = await buy()
    await instance.dataSource
      .getRepository(TokenPackage)
      .update({ slug: TESTEO_SEMANAL.slug }, { bonusTokens: 9 })
    await instance.checkout.completeExternalPayment(paymentId, dropiNotice(COP_PRICE))

    expect((await tokenWalletOf(instance.dataSource, BRAND))!.giftTokens).toBe('2.00')
  })

  it('a notice with another amount after the tokens were credited still completes the payment', async () => {
    // R15: red when hasPaymentTakenEffect ignores the token keys: the notice is marked a mismatch.
    const paymentId = await buy()
    jest
      .spyOn(instance.moduleRef.get(InvoiceService), 'create')
      .mockRejectedValueOnce(new Error('invoice store down'))
    await expect(
      instance.checkout.completeExternalPayment(paymentId, dropiNotice(COP_PRICE)),
    ).rejects.toThrow()

    await instance.checkout.completeExternalPayment(paymentId, dropiNotice(1))

    const payment = (await paymentsOf(instance.dataSource, BRAND))[0]
    expect(payment.status).toBe(PaymentStatus.COMPLETED)
    expect(payment.metadata.amountMismatch).toBeUndefined()
    expect((await tokenWalletOf(instance.dataSource, BRAND))!.balance).toBe('27.00')
  })

  it('refuses provider wallet with 422, saving no payment and opening no token wallet', async () => {
    // R15: red when prepareTokenPackage drops the external-only guard: 400 MISSING_WALLET_ID.
    await expect(buy({ provider: 'wallet' })).rejects.toMatchObject({
      status: 422,
      code: 'TOKEN_PACKAGE_EXTERNAL_ONLY',
    })
    expect(await paymentsOf(instance.dataSource, BRAND)).toHaveLength(0)
    expect(await tokenWalletOf(instance.dataSource, BRAND)).toBeNull()
  })

  it('refuses with 503 and saves no payment when the TRM source is down and nothing is cached', async () => {
    // R15: red when a Colombian package is priced without the TRM: the payment is saved in USD.
    // Its own instance: the shared one keeps the rate of the cases above cached for an hour.
    const down = await startTrmSource(trmDown)
    const cold = await startInstance({ realBilling: true, trmUrl: down.url })
    try {
      fakeDropi(cold)
      await expect(cold.checkout.processCheckout(packageCheckout(BRAND, id))).rejects.toMatchObject(
        { status: 503, code: 'EXCHANGE_RATE_UNAVAILABLE' },
      )
      expect(down.hits).toBe(1)
      expect(await paymentsOf(instance.dataSource, BRAND)).toHaveLength(0)
      expect(await tokenWalletOf(instance.dataSource, BRAND)).toBeNull()
    } finally {
      await stopInstance(cold)
      await down.close()
    }
  })

  it('refuses with 422 WALLET_CLOSED and saves no payment when the brand token wallet is closed', async () => {
    // R15: red when prepareTokenPackage drops the closed-wallet guard: a payment row is saved.
    const wallet = await instance.moduleRef.get(TokenWalletService).getOrCreate(BRAND, BRAND)
    await instance.dataSource.query(`UPDATE wallets SET status = 'closed' WHERE id = $1`, [
      wallet.id,
    ])

    await expect(buy()).rejects.toMatchObject({ status: 422, code: 'WALLET_CLOSED' })
    expect(await paymentsOf(instance.dataSource, BRAND)).toHaveLength(0)
  })
})
