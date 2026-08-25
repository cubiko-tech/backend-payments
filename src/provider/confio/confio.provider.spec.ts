import { createServer, Server, IncomingMessage, ServerResponse } from 'http'
import { AddressInfo } from 'net'
import { ConfioProvider } from './confio.provider'

/**
 * `describe('createCheckout')` pisa `global.fetch` con un jest.fn() y NO lo
 * restaura: `jest.restoreAllMocks()` no deshace una asignación directa a un
 * global. Sin esta referencia, todo describe declarado después heredaría ese
 * stub y "verificaría" el payload contra una respuesta fija, sin tocar la red.
 */
const REAL_FETCH = global.fetch

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

  /**
   * Planes de suscripción contra un servidor HTTP REAL (no un mock de fetch):
   * es la única forma de verificar la URL efectiva —incluido que el `/v1` no se
   * duplique— y el payload tal como sale por el socket.
   *
   * Formas tomadas de una respuesta REAL del store de dev
   * (`GET /v1/stores/{store}/subscription-plans`, 2026-08-25), no de la doc:
   * ojo que `nextPageToken` llega como **string vacío** cuando no hay más
   * páginas, no ausente.
   */
  describe('planes de suscripción (servidor HTTP de prueba)', () => {
    let server: Server
    let received: Array<{ method: string; url: string; headers: any; body: any }>
    let respond: (req: IncomingMessage, res: ServerResponse) => void

    beforeEach(async () => {
      // Restaurar el fetch real ANTES de construir el provider: el describe de
      // createCheckout dejó un jest.fn() pegado a global.fetch.
      ;(global as any).fetch = REAL_FETCH

      received = []
      respond = (_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      }

      server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString()
          received.push({
            method: req.method!,
            url: req.url!,
            headers: req.headers,
            body: raw ? JSON.parse(raw) : null,
          })
          respond(req, res)
        })
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const { port } = server.address() as AddressInfo
      // El provider lee el env en el CONSTRUCTOR: primero el env, después el new.
      process.env.CONFIO_API_BASE_URL = `http://127.0.0.1:${port}/v1`
    })

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    const planResponse = (over: Record<string, any> = {}) => ({
      name: 'stores/01TESTSTORE/subscription-plans/01PLAN',
      displayName: 'ROAX Pro (Dropi) - Mensual COP',
      amountCents: 1990000,
      currencyCode: 'COP',
      billingCycleFrequency: 'MONTHLY',
      billingCycleInterval: 1,
      trialPeriodDays: 15,
      status: 'ACTIVE',
      createTime: '2026-08-25T12:31:48.925Z',
      updateTime: '2026-08-25T12:31:48.925Z',
      ...over,
    })

    describe('createSubscriptionPlan', () => {
      it('POSTea a /stores/{id}/subscription-plans (sin duplicar /v1) con amountCents en CENTAVOS', async () => {
        respond = (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(planResponse()))
        }

        const provider = new ConfioProvider()
        const plan = await provider.createSubscriptionPlan({
          displayName: 'ROAX Pro (Dropi) - Mensual COP',
          amountCents: 1990000,
          currencyCode: 'COP',
          trialPeriodDays: 15,
        })

        expect(received).toHaveLength(1)
        expect(received[0].url).toBe('/v1/stores/01TESTSTORE/subscription-plans')
        expect(received[0].method).toBe('POST')
        expect(received[0].headers.authorization).toBe('Bearer test-token-123')
        expect(received[0].body).toEqual({
          displayName: 'ROAX Pro (Dropi) - Mensual COP',
          amountCents: 1990000,
          currencyCode: 'COP',
          billingCycleFrequency: 'MONTHLY',
          billingCycleInterval: 1,
          trialPeriodDays: 15,
        })
        // Un "1990000" string lo aceptaría el deep-equal de arriba jamás, pero
        // el que importa de verdad es el tipo que sale por el socket.
        expect(typeof received[0].body.amountCents).toBe('number')

        // La respuesta se devuelve completa, con `name` incluido.
        expect(plan).toEqual(planResponse())
      })

      it('manda 699 para USD (6.99 USD en centavos) y respeta la moneda', async () => {
        respond = (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(planResponse({ amountCents: 699, currencyCode: 'USD' })))
        }

        const provider = new ConfioProvider()
        const plan = await provider.createSubscriptionPlan({
          displayName: 'ROAX Pro (Dropi) - Mensual USD',
          amountCents: 699,
          currencyCode: 'USD',
          trialPeriodDays: 15,
        })

        expect(received[0].body.amountCents).toBe(699)
        expect(received[0].body.currencyCode).toBe('USD')
        expect(received[0].body.billingCycleFrequency).toBe('MONTHLY')
        expect(received[0].body.billingCycleInterval).toBe(1)
        expect(received[0].body.trialPeriodDays).toBe(15)
        expect(plan.amountCents).toBe(699)
      })

      it('propaga el error de ConfioPagos con su status cuando no es 2xx', async () => {
        respond = (_req, res) => {
          res.writeHead(422, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ message: 'amountCents must be > 0' }))
        }

        const provider = new ConfioProvider()
        await expect(
          provider.createSubscriptionPlan({
            displayName: 'x',
            amountCents: 1990000,
            currencyCode: 'COP',
            trialPeriodDays: 15,
          }),
        ).rejects.toThrow(/ConfioPagos error 422/)
      })
    })

    describe('listSubscriptionPlans', () => {
      it('GETea y sigue nextPageToken, concatenando las páginas del envelope {plans,nextPageToken}', async () => {
        respond = (req, res) => {
          const token = new URL(req.url!, 'http://x').searchParams.get('pageToken')
          res.writeHead(200, { 'Content-Type': 'application/json' })
          if (!token) {
            res.end(
              JSON.stringify({
                plans: [planResponse({ name: 'stores/01TESTSTORE/subscription-plans/P1' })],
                nextPageToken: 'tok-2',
              }),
            )
          } else {
            res.end(
              JSON.stringify({
                plans: [planResponse({ name: 'stores/01TESTSTORE/subscription-plans/P2' })],
                // Confío devuelve string VACÍO cuando no hay más páginas (visto en dev).
                nextPageToken: '',
              }),
            )
          }
        }

        const provider = new ConfioProvider()
        const plans = await provider.listSubscriptionPlans()

        expect(plans.map((p) => p.name)).toEqual([
          'stores/01TESTSTORE/subscription-plans/P1',
          'stores/01TESTSTORE/subscription-plans/P2',
        ])
        expect(received).toHaveLength(2)
        expect(received[0].method).toBe('GET')
        expect(received[0].url).toMatch(/^\/v1\/stores\/01TESTSTORE\/subscription-plans\?/)
        expect(new URL(received[0].url, 'http://x').searchParams.get('pageToken')).toBeNull()
        expect(new URL(received[1].url, 'http://x').searchParams.get('pageToken')).toBe('tok-2')
      })

      it('tolera una respuesta sin la clave plans en vez de reventar', async () => {
        respond = (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({}))
        }

        const provider = new ConfioProvider()
        await expect(provider.listSubscriptionPlans()).resolves.toEqual([])
      })
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
