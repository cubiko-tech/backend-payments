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

      expect(() => (provider as any).ensureConfigured()).toThrow(
        'Stripe no configurado',
      )
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

      const result = provider.validateWebhookSignature(
        Buffer.from('payload'),
        'sig_test',
      )
      expect(result).toBe(false)
    })

    it('retorna false cuando no hay STRIPE_WEBHOOK_SECRET', () => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_real_key_123'
      delete process.env.STRIPE_WEBHOOK_SECRET

      const provider = new StripeProvider()
      const result = provider.validateWebhookSignature(
        Buffer.from('payload'),
        'sig_test',
      )
      expect(result).toBe(false)
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
})
