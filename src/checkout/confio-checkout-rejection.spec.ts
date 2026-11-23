import { Logger } from '@nestjs/common'

import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { logger } from '../shared/logger/logger'
import { CheckoutRequest, CheckoutService } from './checkout.service'

const REAL_FETCH = global.fetch
const BUYER_EMAIL = 'buyer@example.com'
const REJECTION_BODY = JSON.stringify({
  code: 'INVALID_BUYER\nforged=1',
  message: `buyer ${BUYER_EMAIL} rejected`,
  buyer: { email: BUYER_EMAIL, document: '1234567890' },
  url: 'https://pay.confio/leaked-link',
})

/** The fake ConfioPagos (R17): the real API is external and has a cost; it answers 400. */
function confioRejects(): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status: 400,
    text: async () => REJECTION_BODY,
  }) as unknown as typeof fetch
}

/**
 * Doubles (R17): repositories, catalog, wallets, TRM and tax are in-memory stand-ins because this
 * case only reads what the external path logs and saves; `ConfioProvider` is the real one.
 */
function checkoutWithRealConfio() {
  const saved: Partial<Payment>[] = []
  const paymentRepo = {
    create: jest.fn((row: Partial<Payment>) => ({ id: 'pay-confio-1', ...row })),
    save: jest.fn(async (row: Payment) => {
      saved.push({ ...row })
      return row
    }),
  }
  const tokenPackage = {
    id: 'pkg-10',
    slug: 'basico',
    priceUsd: 10,
    purchasedTokens: 10,
    bonusTokens: 0,
    active: true,
  }
  const confio = new ConfioProvider()
  const stub = (value: unknown) => jest.fn().mockResolvedValue(value)
  const args = [
    paymentRepo,
    {},
    {},
    {},
    { findOne: stub({ country: 'CO' }) },
    {},
    {},
    {},
    {},
    {},
    { getTaxForCountry: stub({ taxName: 'IVA', taxRate: 0.19, isInclusive: true }) },
    {},
    { getProvider: () => confio },
    {},
    {},
    {},
    {},
    { isProviderAvailable: stub(true) },
    {},
    { getUsdCopRate: stub({ rate: 4000, date: '2026-11-06' }) },
    { getOrCreate: stub({ id: 'tkn-1', status: 'active' }) },
    { findActive: stub(tokenPackage) },
    // Auth knows a name and nothing else: an incomplete request buyer finds no contact to complete.
    { resolveBuyerContact: stub({ ok: true, contact: { name: 'Ana Perez' } }) },
  ] as unknown as ConstructorParameters<typeof CheckoutService>

  return { service: new CheckoutService(...args), saved }
}

const packageRequest: CheckoutRequest = {
  brandId: '72a8463b-1111-4c2a-9f1a-66a0985a10e6',
  userId: 'user-1',
  purpose: 'token_package',
  provider: 'confio',
  packageId: 'pkg-10',
  successUrl: 'https://ads.roax.ai/tokens',
  buyer: { email: BUYER_EMAIL, phoneNumber: '3001234567' },
} as CheckoutRequest

describe('Confio rejection on an external checkout', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      CONFIO_STORE_ID: '01TESTSTORE',
      CONFIO_ACCESS_TOKEN: 'test-token-123',
      CONFIO_API_BASE_URL: 'https://api.dev.confiopagos.com/v1',
      TOKEN_CHECKOUT_ALLOWED_RETURN_URLS: 'https://ads.roax.ai/tokens',
    }
  })

  afterEach(() => {
    process.env = OLD_ENV
    global.fetch = REAL_FETCH
    jest.restoreAllMocks()
  })

  it('fails the payment and logs one line with its id, the 400 and the escaped provider code', async () => {
    // Red if the external checkout catch stops logging: no rejection line is found.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    const others = [
      jest.spyOn(Logger.prototype, 'log').mockImplementation(),
      jest.spyOn(Logger.prototype, 'error').mockImplementation(),
      jest.spyOn(logger, 'log'),
    ]
    confioRejects()
    const { service, saved } = checkoutWithRealConfio()

    const failure = await service.processCheckout(packageRequest).catch((error) => error)

    expect(failure).toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(saved[saved.length - 1].status).toBe(PaymentStatus.FAILED)
    const lines = warn.mock.calls.map((call) => String(call[0]))
    expect(lines.filter((line) => line.startsWith('External checkout rejected'))).toEqual([
      'External checkout rejected: payment=pay-confio-1 provider=confio status=400 ' +
        'code=INVALID_BUYER forged%3D1',
    ])
    const all = [warn, ...others]
      .flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' ')))
      .join('\n')
    expect(all).not.toContain(BUYER_EMAIL)
    expect(all).not.toContain('pay.confio')
    expect(all).not.toContain('1234567890')
  })

  it.each([
    ['phone', { email: BUYER_EMAIL }, 'buyer.phoneNumber'],
    ['email', { phoneNumber: '3001234567' }, 'buyer.email'],
  ])('rejects a buyer without a %s with the 422 of a subscription', async (_, buyer, field) => {
    // Mutation (phone row): `normalizeColombianPhone` returns '+573215786325' for '' -> red.
    // Mutation (email row): `resolveCheckoutBuyer` sends `contact.email || 'pagos@cubiko.co'` -> red.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation()
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ name: 'payments/01PAY', url: 'https://pay.confio/01PAY' }),
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const { service, saved } = checkoutWithRealConfio()

    const failure = await service
      .processCheckout({ ...packageRequest, buyer } as CheckoutRequest)
      .catch((error) => error)

    expect(failure.getStatus()).toBe(422)
    expect(failure.getResponse()).toMatchObject({ code: 'INVALID_BUYER', field })
    expect(saved[saved.length - 1].status).toBe(PaymentStatus.FAILED)
    const sent = fetchMock.mock.calls.map((call) => String(call[1]?.body)).join('\n')
    expect(sent).not.toContain('+573215786325')
    expect(sent).not.toContain('pagos@cubiko.co')
  })
})
