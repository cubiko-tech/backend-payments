import { Payment } from '../payment/entities/payment.entity'
import { WalletStatus } from '../wallet/entities/wallet.entity'
import { TokenOrigin } from '../wallet/token-origin'
import { TokenPackageService } from '../wallet/token-package.service'
import { TokenWalletService } from '../wallet/token-wallet.service'
import {
  assertMatchingIdempotencyPayload,
  buildIdempotencyFingerprint,
} from './checkout-idempotency'
import { CheckoutRequest } from './checkout.service'
import {
  creditTokenAmount,
  creditTokenPackage,
  prepareTokenAmount,
  prepareTokenPackage,
} from './token-package-checkout'

const PACKAGE = {
  id: 'pkg-10',
  slug: 'basico',
  label: 'Recarga Mínima',
  priceUsd: 10,
  purchasedTokens: 10,
  bonusTokens: 0,
  active: true,
}

describe('token package checkout', () => {
  // R17: unit cases; the real catalog, wallet and TRM run in test/token-package-checkout.e2e-spec.ts.
  const tokenWallets = {
    getOrCreate: jest.fn().mockResolvedValue({ id: 'tkn-1', status: WalletStatus.ACTIVE }),
    creditTokens: jest.fn().mockResolvedValue({}),
  }
  const quoteUsdCopRate = jest.fn().mockResolvedValue({ rate: 4000, date: '2026-11-06' })
  const assertProviderAvailable = jest.fn().mockResolvedValue(undefined)
  const deps = (country: string) => ({
    tokenPackages: {
      findActive: jest.fn().mockResolvedValue(PACKAGE),
    } as unknown as TokenPackageService,
    tokenWallets: tokenWallets as unknown as TokenWalletService,
    billingCountry: jest.fn().mockResolvedValue(country),
    assertProviderAvailable,
    quoteUsdCopRate,
  })
  const req = { brandId: 'brand-1', userId: 'user-1', provider: 'stripe', packageId: PACKAGE.id }

  beforeEach(() => jest.clearAllMocks())

  it('charges a non-Colombian brand the USD price without asking for the TRM', async () => {
    // R15: red when chargeFor converts every country to COP: the amount reads 40000.
    const prepared = await prepareTokenPackage(req, deps('MX'))

    expect(prepared).toMatchObject({
      amount: 10,
      currency: 'USD',
      country: 'MX',
      walletId: 'tkn-1',
    })
    expect(prepared.rate).toBeUndefined()
    expect(quoteUsdCopRate).not.toHaveBeenCalled()
  })

  it('refuses a provider not enabled for the country before asking for the TRM', async () => {
    // R15: red when the provider check moves after chargeFor: the TRM is asked and its 503 wins.
    const notEnabled = new Error('PROVIDER_NOT_AVAILABLE')
    assertProviderAvailable.mockRejectedValueOnce(notEnabled)
    quoteUsdCopRate.mockRejectedValueOnce(new Error('EXCHANGE_RATE_UNAVAILABLE'))

    await expect(prepareTokenPackage(req, deps('co'))).rejects.toBe(notEnabled)
    expect(assertProviderAvailable).toHaveBeenCalledWith('CO')
    expect(quoteUsdCopRate).not.toHaveBeenCalled()
    expect(tokenWallets.getOrCreate).not.toHaveBeenCalled()
  })

  it('credits only the purchased tokens of a package without bonus', async () => {
    // R15: red when creditTokenPackage drops its bonus > 0 check: a second, gift call of 0 appears.
    const payment = {
      id: 'pay-1',
      brandId: 'brand-1',
      walletId: 'tkn-1',
      metadata: { tokenPackage: { ...PACKAGE, packageId: PACKAGE.id } },
    } as unknown as Payment

    await creditTokenPackage(payment, tokenWallets as unknown as TokenWalletService)

    expect(tokenWallets.creditTokens.mock.calls.map((call) => [call[1], call[2], call[4]])).toEqual(
      [[10, TokenOrigin.PURCHASED, 'payment:pay-1:tokens:purchased']],
    )
  })

  it('prices a US token_amount checkout at USD 1 per token without asking for the TRM', async () => {
    // R15: red when prepareTokenAmount asks for the TRM on a non-CO brand or misprices tokens.
    const prepared = await prepareTokenAmount(
      {
        brandId: 'brand-us',
        userId: 'user-1',
        provider: 'confio',
        tokens: 250,
        successUrl: 'https://ads.roax.ai/tokens/return',
      },
      { ...deps('US'), allowedReturnUrls: 'https://ads.roax.ai/tokens/return' },
    )

    expect(prepared).toEqual({
      amount: 250,
      currency: 'USD',
      country: 'US',
      walletId: 'tkn-1',
      snapshot: { priceUsd: 250, purchasedTokens: 250 },
    })
    expect(quoteUsdCopRate).not.toHaveBeenCalled()
  })

  it('answers 503 when TOKEN_CHECKOUT_ALLOWED_RETURN_URLS is empty or unset', async () => {
    // R15: red when assertAllowedReturnUrls allows any return URL when the env var is empty.
    await expect(
      prepareTokenAmount(
        {
          brandId: 'brand-us',
          userId: 'user-1',
          provider: 'confio',
          tokens: 250,
          successUrl: 'https://ads.roax.ai/tokens/return',
        },
        { ...deps('US'), allowedReturnUrls: ' , ' },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: 'TOKEN_CHECKOUT_RETURN_URLS_NOT_CONFIGURED',
    })
  })

  it('credits a completed token_amount payment as purchased with its payment key', async () => {
    // R15: red when creditTokenAmount omits the idempotency key or credits gift instead of purchased.
    const payment = {
      id: 'pay-amt-1',
      brandId: 'brand-1',
      walletId: 'tkn-1',
      metadata: { tokenAmount: { priceUsd: 250, purchasedTokens: 250 } },
    } as unknown as Payment

    await creditTokenAmount(payment, tokenWallets as unknown as TokenWalletService)

    expect(tokenWallets.creditTokens.mock.calls.map((call) => [call[1], call[2], call[4]])).toEqual(
      [[250, TokenOrigin.PURCHASED, 'payment:pay-amt-1:tokens:purchased']],
    )
  })

  it('includes tokens in the idempotency fingerprint so another token count conflicts with 409', () => {
    // R15: red when buildIdempotencyFingerprint omits tokens: 250 and 300 share the same fingerprint.
    const base: CheckoutRequest = {
      brandId: 'brand-1',
      userId: 'user-1',
      purpose: 'token_amount',
      provider: 'confio',
      tokens: 250,
      successUrl: 'https://ads.roax.ai/tokens/return',
      idempotencyKey: 'idem-1',
    }
    const fp250 = buildIdempotencyFingerprint(base)
    const fp300 = buildIdempotencyFingerprint({ ...base, tokens: 300 })

    expect(fp250).not.toBe(fp300)
    expect(() =>
      assertMatchingIdempotencyPayload(
        { metadata: { idempotencyFingerprint: fp250 } } as unknown as Payment,
        { ...base, tokens: 300 },
        fp300,
      ),
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_CONFLICT' }))
  })
})
