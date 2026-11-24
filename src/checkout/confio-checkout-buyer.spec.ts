import { Logger } from '@nestjs/common'

import { USER_LOOKUP_UNAVAILABLE } from '../client/client-auth.service'
import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { CheckoutRequest, CheckoutService } from './checkout.service'

const REAL_FETCH = global.fetch
const BRAND_ID = '72a8463b-1111-4c2a-9f1a-66a0985a10e6'
const OWNER_ID = 'owner-7'

/** The fake ConfioPagos (R17): the real API is external and has a cost; it creates the link. */
function confioCreatesLinks(): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 201,
    text: async () => JSON.stringify({ name: 'payments/01PAY', url: 'https://pay.confio/01PAY' }),
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

const sentBuyer = (fetchMock: jest.Mock) =>
  JSON.parse(String(fetchMock.mock.calls[0][1].body)).buyer

/**
 * Doubles (R17): repositories, pricing, platform, auth, wallets, TRM and tax are in-memory stand-ins
 * because these cases only read which buyer reaches Confio; `ConfioProvider` is the real one.
 */
function checkout(auth: { resolveBuyerContact: jest.Mock }) {
  const saved: Partial<Payment>[] = []
  const paymentRepo = {
    create: jest.fn((row: Partial<Payment>) => ({ id: 'pay-buyer-1', ...row })),
    save: jest.fn(async (row: Payment) => {
      saved.push({ ...row })
      return row
    }),
    findOne: jest.fn().mockResolvedValue(null),
  }
  const stub = (value: unknown) => jest.fn().mockResolvedValue(value)
  const platform = {
    resolveBrandCountry: stub({ ok: true, country: 'CO' }),
    resolveBrandOwner: stub({ ok: true, owner: OWNER_ID }),
  }
  const price = { id: 'price-1', countryCode: 'CO', currency: 'COP', price: 19900, isDefault: true }
  const tokenPackage = {
    id: 'pkg-10',
    slug: 'basico',
    priceUsd: 10,
    purchasedTokens: 10,
    bonusTokens: 0,
    active: true,
  }
  const args = [
    paymentRepo,
    { create: jest.fn((row: unknown) => row), save: stub({}) },
    { findOne: stub(null), find: stub([]) },
    {},
    { findOne: stub({ country: 'CO' }) },
    {},
    {},
    {},
    {},
    {},
    { getTaxForCountry: stub({ taxName: 'IVA', taxRate: 0.19, isInclusive: true }) },
    {},
    { getProvider: () => new ConfioProvider() },
    {},
    { resolvePriceForCountry: stub({ ok: true, price }) },
    platform,
    { getForBrand: stub(null) },
    { isProviderAvailable: stub(true) },
    {},
    { getUsdCopRate: stub({ rate: 4000, date: '2026-11-06' }) },
    { getOrCreate: stub({ id: 'tkn-1', status: 'active' }) },
    { findActive: stub(tokenPackage) },
    auth,
  ] as unknown as ConstructorParameters<typeof CheckoutService>

  return { service: new CheckoutService(...args), saved, platform }
}

/** The auth double (R17): backend-auth is a network service; it answers with the given contact. */
const authWith = (contact: Record<string, string>) => ({
  resolveBuyerContact: jest.fn().mockResolvedValue({ ok: true, contact }),
})

const planFromFront: CheckoutRequest = {
  brandId: BRAND_ID,
  userId: 'user-1',
  purpose: 'plan_purchase',
  provider: 'confio',
  planSlug: 'dropi-roax',
  successUrl: 'https://app.roax.ai/plans',
  buyer: { email: 'ana@front.co', firstName: 'Ana' },
}

const packageFromAds: CheckoutRequest = {
  brandId: BRAND_ID,
  userId: undefined,
  purpose: 'token_package',
  provider: 'confio',
  packageId: 'pkg-10',
  successUrl: 'https://ads.roax.ai/tokens',
}

describe('Confio one-shot checkout buyer from auth', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      CONFIO_STORE_ID: '01TESTSTORE',
      CONFIO_ACCESS_TOKEN: 'test-token-123',
      CONFIO_API_BASE_URL: 'https://api.dev.confiopagos.com/v1',
      TOKEN_CHECKOUT_ALLOWED_RETURN_URLS: 'https://ads.roax.ai/tokens',
    }
    // Silenced logger: these cases read the buyer sent, not the log lines.
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation()
    }
  })

  afterEach(() => {
    process.env = OLD_ENV
    global.fetch = REAL_FETCH
    jest.restoreAllMocks()
  })

  it('completes a front plan buyer with the auth phone in E.164 and keeps its name and email', async () => {
    // Mutation: `resolveCheckoutBuyer` returns `req.buyer` always (only the request buyer) -> 422, red.
    const fetchMock = confioCreatesLinks()
    const auth = authWith({
      email: 'ana@auth.co',
      name: 'Ana Auth',
      phone: '3001234567',
      callingCode: '57',
    })
    const { service } = checkout(auth)

    const result = await service.processCheckout(planFromFront)

    expect(result.checkoutUrl).toBe('https://pay.confio/01PAY')
    expect(auth.resolveBuyerContact).toHaveBeenCalledWith('user-1')
    expect(sentBuyer(fetchMock)).toMatchObject({
      email: 'ana@front.co',
      firstName: 'Ana',
      phoneNumber: '+573001234567',
    })
  })

  it('takes the brand owner contact for an Ads package without buyer nor user', async () => {
    // Mutation: `resolveCheckoutBuyer` looks up `req.userId` without asking for the owner -> red.
    const fetchMock = confioCreatesLinks()
    const auth = authWith({ email: 'owner@brand.co', name: 'Olga Duena', phone: '+573109876543' })
    const { service, platform } = checkout(auth)

    const result = await service.processCheckout(packageFromAds)

    expect(result.checkoutUrl).toBe('https://pay.confio/01PAY')
    expect(platform.resolveBrandOwner).toHaveBeenCalledWith(BRAND_ID)
    expect(auth.resolveBuyerContact).toHaveBeenCalledWith(OWNER_ID)
    expect(sentBuyer(fetchMock)).toMatchObject({
      email: 'owner@brand.co',
      firstName: 'Olga',
      lastName: 'Duena',
      phoneNumber: '+573109876543',
    })
  })

  it('answers 422 INVALID_BUYER and fails the payment when auth has no phone, without calling Confio', async () => {
    // Mutation: `resolveCheckoutBuyer` fills a missing auth phone with '+573000000000' -> Confio called, red.
    const fetchMock = confioCreatesLinks()
    const { service, saved } = checkout(
      authWith({ email: 'ana@auth.co', name: 'Ana Auth', callingCode: '57' }),
    )

    const failure = await service.processCheckout(planFromFront).catch((error) => error)

    expect(failure.getStatus()).toBe(422)
    expect(failure.getResponse()).toMatchObject({
      code: 'INVALID_BUYER',
      field: 'buyer.phoneNumber',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(saved[saved.length - 1].status).toBe(PaymentStatus.FAILED)
  })

  it('answers the transient 503 when auth is down, never INVALID_BUYER, without calling Confio', async () => {
    // Mutation: `BuyerLookupFailure.toException` answers 422 INVALID_BUYER for every code -> red.
    const fetchMock = confioCreatesLinks()
    const auth = {
      resolveBuyerContact: jest
        .fn()
        .mockResolvedValue({ ok: false, code: USER_LOOKUP_UNAVAILABLE }),
    }
    const { service, saved } = checkout(auth)

    const failure = await service.processCheckout(planFromFront).catch((error) => error)

    expect(failure.getStatus()).toBe(503)
    expect(failure.getResponse()).toMatchObject({ code: USER_LOOKUP_UNAVAILABLE })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(saved[saved.length - 1].status).toBe(PaymentStatus.FAILED)
  })
})
