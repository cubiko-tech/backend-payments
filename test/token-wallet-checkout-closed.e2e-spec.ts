/**
 * Only a token package opens a TKN wallet: a recharge, a debit or a service payment against one is
 * refused with 422 before any payment is saved, and a wallet that is not there, or cannot be
 * read, stops the checkout the same way. PostgreSQL holds the payments and the wallets.
 */
import { config as dotenvConfig } from 'dotenv'

import { CheckoutRequest } from '../src/checkout/checkout.service'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { cleanPackageBrand, fakeDropi, paymentsOf } from './support/token-package.fixture'
import { RaceInstance, startInstance, stopInstance } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'b1360000-0000-4000-8000-0000000005c5'

describe('Checkout against a token wallet or a missing wallet (PostgreSQL, LOC-136)', () => {
  let instance: RaceInstance
  let tkn: Wallet

  const checkout = (overrides: Partial<CheckoutRequest>) =>
    instance.checkout.processCheckout({
      brandId: BRAND,
      userId: 'user-loc136',
      purpose: 'wallet_recharge',
      provider: 'dropi',
      amount: 100000,
      currency: 'COP',
      ...overrides,
    })
  const tknUntouched = async () => {
    const wallet = await instance.dataSource.getRepository(Wallet).findOneByOrFail({ id: tkn.id })
    const moves = await instance.dataSource.getRepository(Transaction).countBy({ walletId: tkn.id })
    return { balance: wallet.balance, moves }
  }

  beforeAll(async () => {
    instance = await startInstance()
  })

  beforeEach(async () => {
    await cleanPackageBrand(instance.dataSource, BRAND)
    const wallets = instance.dataSource.getRepository(Wallet)
    tkn = await wallets.save(
      wallets.create({
        brandId: BRAND,
        userId: BRAND,
        provider: 'internal',
        currency: 'TKN',
        balance: 30,
        purchasedTokens: 30,
        status: WalletStatus.ACTIVE,
      }),
    )
    fakeDropi(instance)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanPackageBrand(instance.dataSource, BRAND)
    await stopInstance(instance)
  })

  it.each(['COP', 'TKN'])(
    'CA5 an external wallet_recharge in %s with a TKN walletId answers 422 and saves no payment',
    async (currency) => {
      // R15: red when assertWalletCurrency drops its TKN clauses: the TKN case saves a payment.
      await expect(checkout({ walletId: tkn.id, currency })).rejects.toMatchObject({
        status: 422,
        code: 'WALLET_CURRENCY_MISMATCH',
      })
      expect(await paymentsOf(instance.dataSource, BRAND)).toHaveLength(0)
      expect(await tknUntouched()).toEqual({ balance: '30.00', moves: 0 })
    },
  )

  it('CA5 a service payment debited from the TKN wallet answers 422 and debits nothing', async () => {
    // R15: red when assertWalletCurrency drops its TKN clauses: a payment row is saved.
    await expect(
      checkout({
        purpose: 'service_payment',
        provider: 'wallet',
        walletId: tkn.id,
        currency: 'TKN',
        amount: 10,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'WALLET_CURRENCY_MISMATCH' })
    expect(await paymentsOf(instance.dataSource, BRAND)).toHaveLength(0)
    expect(await tknUntouched()).toEqual({ balance: '30.00', moves: 0 })
  })

  it('CA5 a recharge to a walletId that does not exist answers 404 and saves no payment', async () => {
    // R15: red when WalletService.findById stops throwing 404 for an unknown id: it answers 503.
    await expect(
      checkout({ walletId: '00000000-0000-4000-8000-0000000000aa' }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'WALLET_NOT_FOUND',
    })
    expect(await paymentsOf(instance.dataSource, BRAND)).toHaveLength(0)
  })

  it('a recharge whose wallet cannot be read answers 503 and saves no payment', async () => {
    // R15: red when assertWalletCurrency returns again on a missing wallet: the payment is saved.
    // R17: findById swallows a failed read into { error }; a real outage cannot be provoked here.
    jest.spyOn(instance.wallet, 'findById').mockResolvedValueOnce({ error: 'read failed' } as any)

    await expect(checkout({ walletId: tkn.id })).rejects.toMatchObject({
      status: 503,
      code: 'WALLET_LOOKUP_UNAVAILABLE',
    })
    expect(await paymentsOf(instance.dataSource, BRAND)).toHaveLength(0)
  })
})
