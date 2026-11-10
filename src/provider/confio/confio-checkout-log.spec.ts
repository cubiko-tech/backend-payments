import { logger } from '../../shared/logger/logger'
import { ConfioProvider } from './confio.provider'

const REAL_FETCH = global.fetch
const PAYMENT_LINK = 'https://pay.confio/abc'

describe('ConfioProvider checkout log line', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      CONFIO_STORE_ID: '01TESTSTORE',
      CONFIO_ACCESS_TOKEN: 'test-token-123',
      CONFIO_API_BASE_URL: 'https://api.dev.confiopagos.com/v1',
    }
  })

  afterEach(() => {
    process.env = OLD_ENV
    global.fetch = REAL_FETCH
    jest.restoreAllMocks()
  })

  it('logs the created payment name and never its payment link', async () => {
    // Red if the line logs `resp.url` again: the link shows up in the captured log.
    const logSpy = jest.spyOn(logger, 'log')
    // The fake ConfioPagos (R17): the real API is external and has a cost.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ name: 'payments/abc123', url: PAYMENT_LINK }),
    }) as unknown as typeof fetch

    const result = await new ConfioProvider().createCheckout({
      amount: 99000,
      currency: 'COP',
      brandId: 'b1',
      userId: 'u1',
      purpose: 'plan_purchase',
      purposeId: 'pro',
      successUrl: 'https://app/return',
      metadata: { paymentId: 'pay-1', buyer: { email: 'x@y.com', phoneNumber: '3001234567' } },
    })

    const lines = logSpy.mock.calls.map((call) => String(call[1])).join('\n')
    expect(lines).toContain('ConfioProvider: pago creado payments/abc123')
    expect(lines).not.toContain(PAYMENT_LINK)
    expect(result.checkoutUrl).toBe(PAYMENT_LINK)
  })
})
