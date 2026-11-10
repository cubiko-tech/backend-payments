// Mock de stripe ANTES de importar el provider
jest.mock('stripe', () => {
  const mockStripe = jest.fn().mockImplementation(() => ({
    checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
    refunds: { create: jest.fn() },
    subscriptions: { cancel: jest.fn() },
    paymentMethods: { detach: jest.fn() },
    webhooks: { constructEvent: jest.fn() },
  }))
  return { __esModule: true, default: mockStripe }
})

jest.mock('../../shared/logger/logger', () => ({
  logger: { log: jest.fn() },
}))

import { StripeProvider } from './stripe.provider'

describe('StripeProvider', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterAll(() => {
    process.env = originalEnv
  })

  describe('constructor', () => {
    it('no crashea cuando STRIPE_SECRET_KEY no está configurado', () => {
      delete process.env.STRIPE_SECRET_KEY

      const provider = new StripeProvider()
      expect(provider.name).toBe('stripe')
    })

    it('no crashea cuando STRIPE_SECRET_KEY es CHANGEME', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_CHANGEME'

      const provider = new StripeProvider()
      expect(provider.name).toBe('stripe')
    })

    it('inicializa Stripe cuando hay key válida', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_real_key_123'

      const provider = new StripeProvider()
      expect(provider.name).toBe('stripe')
    })
  })

  describe('ensureConfigured', () => {
    it('lanza error cuando no está configurado', () => {
      delete process.env.STRIPE_SECRET_KEY
      const provider = new StripeProvider()

      expect(() => (provider as any).ensureConfigured()).toThrow('Stripe no configurado')
    })

    it('no lanza error cuando está configurado', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_real_key_123'
      const provider = new StripeProvider()

      expect(() => (provider as any).ensureConfigured()).not.toThrow()
    })
  })

  describe('validateWebhookSignature', () => {
    it('retorna false cuando no está configurado', () => {
      delete process.env.STRIPE_SECRET_KEY
      const provider = new StripeProvider()

      const result = provider.validateWebhookSignature(Buffer.from('payload'), 'sig_test')
      expect(result).toBe(false)
    })

    it('retorna false cuando no hay STRIPE_WEBHOOK_SECRET', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_real_key_123'
      delete process.env.STRIPE_WEBHOOK_SECRET

      const provider = new StripeProvider()
      const result = provider.validateWebhookSignature(Buffer.from('payload'), 'sig_test')
      expect(result).toBe(false)
    })

    it('rejects a webhook when STRIPE_WEBHOOK_SECRET is CHANGEME without calling constructEvent', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_real_key_123'
      process.env.STRIPE_WEBHOOK_SECRET = 'CHANGEME'

      const provider = new StripeProvider()
      const result = provider.validateWebhookSignature(Buffer.from('payload'), 'sig_changeme')

      expect(result).toBe(false)
      expect((provider as any).stripe.webhooks.constructEvent).not.toHaveBeenCalled()
    })

    it('throws when constructWebhookEvent is called with STRIPE_WEBHOOK_SECRET set to CHANGEME', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_real_key_123'
      process.env.STRIPE_WEBHOOK_SECRET = 'CHANGEME'

      const provider = new StripeProvider()

      expect(() => provider.constructWebhookEvent(Buffer.from('payload'), 'sig_changeme')).toThrow(
        /webhook secret/i,
      )
    })
  })

  describe('createCheckout', () => {
    it('lanza error cuando no está configurado', async () => {
      delete process.env.STRIPE_SECRET_KEY
      const provider = new StripeProvider()

      await expect(
        provider.createCheckout({
          amount: 100,
          currency: 'COP',
          brandId: 'b1',
          userId: 'u1',
          purpose: 'plan_purchase',
        }),
      ).rejects.toThrow('Stripe no configurado')
    })
  })

  describe('getPaymentStatus', () => {
    it('returns pending when checkout session is complete but payment_status is unpaid or no_payment_required, and completed only when payment_status is paid', async () => {
      // R15: red if getPaymentStatus maps session.status === 'complete' without payment_status === 'paid'.
      process.env.STRIPE_SECRET_KEY = 'sk_test_real_key_123'
      const provider = new StripeProvider()
      const retrieve = (provider as any).stripe.checkout.sessions.retrieve as jest.Mock

      retrieve.mockResolvedValueOnce({
        status: 'complete',
        payment_status: 'unpaid',
        created: 1700000000,
        amount_total: 10000,
      })

      const unpaidResult = await provider.getPaymentStatus('cs_test_unpaid')
      expect(unpaidResult.status).toBe('pending')
      expect(unpaidResult.paidAt).toBeUndefined()

      retrieve.mockResolvedValueOnce({
        status: 'complete',
        payment_status: 'paid',
        created: 1700000000,
        amount_total: 10000,
      })

      const paidResult = await provider.getPaymentStatus('cs_test_paid')
      expect(paidResult.status).toBe('completed')
      expect(paidResult.paidAt).toEqual(new Date(1700000000 * 1000))
      expect(paidResult.metadata).toMatchObject({ amountTotal: 10000 })
    })
  })
})
