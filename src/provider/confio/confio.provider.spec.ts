import { ConfioProvider } from './confio.provider'

describe('ConfioProvider', () => {
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
    jest.restoreAllMocks()
  })

  describe('createCheckout', () => {
    it('POSTea a /stores/{id}/payments con amountCents=monto*100 y correlationId, y devuelve el link', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ name: 'payments/abc123', url: 'https://pay.confio/abc' }),
      })
      ;(global as any).fetch = fetchMock

      const provider = new ConfioProvider()
      const result = await provider.createCheckout({
        amount: 99000,
        currency: 'COP',
        brandId: 'b1',
        userId: 'u1',
        purpose: 'plan_purchase',
        purposeId: 'starter',
        successUrl: 'https://app/return',
        metadata: { paymentId: 'pay-1', buyer: { email: 'x@y.com', phoneNumber: '3001234567' } },
      })

      expect(result).toEqual({ providerPaymentId: 'payments/abc123', checkoutUrl: 'https://pay.confio/abc', status: 'pending' })
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('https://api.dev.confiopagos.com/v1/stores/01TESTSTORE/payments')
      const sent = JSON.parse(opts.body)
      expect(sent.amountCents).toBe(9900000)
      expect(sent.currencyCode).toBe('COP')
      expect(sent.correlationId).toBe('pay-1')
      expect(sent.paymentType).toBe('SERVICE')
      expect(sent.buyer.email).toBe('x@y.com')
      expect(sent.buyer.phoneNumber).toBe('+573001234567')
      expect(opts.headers.Authorization).toBe('Bearer test-token-123')
    })

    it('lanza si no está configurado', async () => {
      process.env.CONFIO_STORE_ID = ''
      process.env.CONFIO_ACCESS_TOKEN = ''
      const provider = new ConfioProvider()
      await expect(
        provider.createCheckout({ amount: 1, currency: 'COP', brandId: 'b', userId: 'u', purpose: 'plan_purchase' }),
      ).rejects.toThrow(/no configurado/)
    })
  })

  describe('mapStatus', () => {
    it.each([
      ['FUNDED', 'completed'],
      ['APPROVED', 'completed'],
      ['DELIVERING', 'completed'],
      ['AWAITING_PAYMENT', 'pending'],
      ['PAYMENT_IN_PROGRESS', 'processing'],
      ['REFUNDED', 'refunded'],
      ['EXPIRED', 'failed'],
      ['CANCELED', 'failed'],
      ['FAILED', 'failed'],
      ['UNKNOWN_X', 'pending'],
    ])('%s → %s', (confio, expected) => {
      expect(ConfioProvider.mapStatus(confio)).toBe(expected)
    })
  })

  describe('validateWebhookSignature', () => {
    it('acepta el token correcto y rechaza el incorrecto', () => {
      const provider = new ConfioProvider()
      expect(provider.validateWebhookSignature(Buffer.from('{}'), 'test-token-123')).toBe(true)
      expect(provider.validateWebhookSignature(Buffer.from('{}'), 'wrong')).toBe(false)
    })
  })

  describe('normalizeColombianPhone', () => {
    it.each([
      ['3001234567', '+573001234567'],
      ['+573001234567', '+573001234567'],
      ['573001234567', '+573001234567'],
      ['', '+573215786325'],
      ['123', '+573215786325'],
    ])('%s → %s', (raw, expected) => {
      expect(ConfioProvider.normalizeColombianPhone(raw)).toBe(expected)
    })
  })
})
