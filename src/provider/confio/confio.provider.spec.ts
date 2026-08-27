import { createServer, Server, IncomingMessage, ServerResponse } from 'http'
import { AddressInfo } from 'net'
import { ConfioProvider, ConfioSubscriptionInputError } from './confio.provider'

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

  /**
   * Suscripciones contra un servidor HTTP REAL, por el mismo motivo que el
   * bloque de planes: es la única forma de asertar la URL efectiva —incluido
   * que el `/v1` no se duplique— y el JSON tal como sale por el socket.
   *
   * Formas MEDIDAS contra el store de dev con una sonda real el **2026-08-26**
   * (`POST …/{plan}/subscriptions` sobre el plan COP `01M0Z020DYMXKKDHHR4HAX916R`
   * y su `GET` de vuelta), no inferidas de la doc. Lo que devolvió:
   *
   * - claves exactas en `PENDING_ACCEPTANCE`: `name`, `status`, `buyer`,
   *   `correlationId`, `acceptanceUrl`, `acceptanceExpireTime`, `createTime`.
   *   **Ningún** `currentPeriodStart` / `currentPeriodEnd` / `nextBillingTime`:
   *   el alta no abre período, confirmado y no supuesto.
   * - `name` SIN prefijo `organizations/…`, empieza directo en `stores/`. El
   *   recorte se prueba igual porque el ejemplo de webhook sí lo trae prefijado.
   * - `acceptanceExpireTime` a 90 minutos fue aceptado (el spec pide entre 1
   *   hora y 30 días); vuelve como el mismo ISO que se mandó.
   * - las opcionales que no se mandan tampoco vuelven en la respuesta.
   */
  describe('suscripciones (servidor HTTP de prueba)', () => {
    let server: Server
    let received: Array<{ method: string; url: string; headers: any; body: any }>
    let respond: (req: IncomingMessage, res: ServerResponse) => void

    const PLAN = 'stores/01TESTSTORE/subscription-plans/01PLAN'
    const SUB = `${PLAN}/subscriptions/01SUB`

    const buyer = () => ({
      email: 'comprador@roaxai.com',
      phoneNumber: '+573001234567',
      firstName: 'Santiago',
      lastName: 'García',
    })

    beforeEach(async () => {
      // Restaurar el fetch real ANTES de construir el provider: el describe de
      // createCheckout dejó un jest.fn() pegado a global.fetch y
      // jest.restoreAllMocks() no deshace una asignación a un global.
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

    const subResponse = (over: Record<string, any> = {}) => ({
      name: SUB,
      status: 'PENDING_ACCEPTANCE',
      buyer: buyer(),
      createTime: '2026-08-26T10:30:00Z',
      correlationId: 'sub-alta-1',
      acceptanceUrl: 'https://checkout.confiopagos.com/s/abc123token',
      acceptanceExpireTime: '2026-08-26T12:00:00Z',
      ...over,
    })

    /**
     * Captura el rechazo con su tipo. Un `.catch((e) => e)` deja una unión con
     * el valor resuelto y esconde `code`/`field`; además esto falla explícito
     * si la promesa RESUELVE, que es justo lo que no queremos que pase inadvertido.
     */
    const rechazo = async (p: Promise<unknown>): Promise<ConfioSubscriptionInputError> => {
      try {
        await p
      } catch (e) {
        return e as ConfioSubscriptionInputError
      }
      throw new Error('se esperaba un rechazo y la promesa resolvió')
    }

    const replyWith = (payload: any, status = 200) => {
      respond = (_req, res) => {
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
    }

    describe('createSubscription', () => {
      it('POSTea a …/{plan}/subscriptions (sin duplicar /v1) con el buyer completo', async () => {
        replyWith(subResponse())

        const provider = new ConfioProvider()
        await provider.createSubscription({ planName: PLAN, buyer: buyer() })

        expect(received).toHaveLength(1)
        expect(received[0].method).toBe('POST')
        expect(received[0].url).toBe('/v1/stores/01TESTSTORE/subscription-plans/01PLAN/subscriptions')
        expect(received[0].headers.authorization).toBe('Bearer test-token-123')
        expect(received[0].body.buyer).toEqual({
          email: 'comprador@roaxai.com',
          phoneNumber: '+573001234567',
          firstName: 'Santiago',
          lastName: 'García',
        })
      })

      it('NO manda las claves opcionales que no vinieron (verificado con Object.keys)', async () => {
        replyWith(subResponse())

        const provider = new ConfioProvider()
        await provider.createSubscription({ planName: PLAN, buyer: buyer() })

        // `toBeUndefined()` pasaría igual si la clave viajara con valor undefined;
        // lo que importa es qué claves salieron por el socket.
        expect(Object.keys(received[0].body).sort()).toEqual(['buyer'])
      })

      it('manda las 4 opcionales con su tipo cuando vienen', async () => {
        replyWith(subResponse())

        const provider = new ConfioProvider()
        await provider.createSubscription({
          planName: PLAN,
          buyer: buyer(),
          correlationId: 'sub-alta-1',
          firstChargeAmountCents: 995000,
          redirectUri: 'https://app.roaxai.com/roax/suscripcion',
          acceptanceExpireTime: '2026-08-26T12:00:00Z',
        })

        const sent = received[0].body
        expect(sent.correlationId).toBe('sub-alta-1')
        expect(sent.firstChargeAmountCents).toBe(995000)
        expect(typeof sent.firstChargeAmountCents).toBe('number')
        expect(sent.redirectUri).toBe('https://app.roaxai.com/roax/suscripcion')
        expect(sent.acceptanceExpireTime).toBe('2026-08-26T12:00:00Z')
      })

      it('manda firstChargeAmountCents: 0 y correlationId vacío TAL CUAL (no por truthiness)', async () => {
        replyWith(subResponse())

        const provider = new ConfioProvider()
        await provider.createSubscription({
          planName: PLAN,
          buyer: buyer(),
          firstChargeAmountCents: 0,
          correlationId: '',
        })

        // `minimum: 0` es válido en el spec y significa PRIMER CICLO GRATIS.
        // Un spread por truthiness se lo tragaría y Confío cobraría el ciclo entero.
        expect(received[0].body.firstChargeAmountCents).toBe(0)
        expect(Object.keys(received[0].body)).toContain('firstChargeAmountCents')
        expect(received[0].body.correlationId).toBe('')
      })

      it('mapea el envelope PENDING_ACCEPTANCE: sin períodos y con el link de aceptación', async () => {
        replyWith(subResponse())

        const provider = new ConfioProvider()
        const result = await provider.createSubscription({ planName: PLAN, buyer: buyer() })

        expect(result.providerSubscriptionId).toBe(SUB)
        expect(result.status).toBe('PENDING_ACCEPTANCE')
        expect(result.acceptanceUrl).toBe('https://checkout.confiopagos.com/s/abc123token')
        expect(result.acceptanceExpireTime).toEqual(new Date('2026-08-26T12:00:00Z'))
        expect(result.correlationId).toBe('sub-alta-1')
        // El alta NO cobra ni abre período: Confío no manda estos campos todavía.
        expect(result.currentPeriodStart).toBeUndefined()
        expect(result.currentPeriodEnd).toBeUndefined()
        expect(result.nextBillingTime).toBeUndefined()
      })

      it('deja el acceptanceUrl FUERA de `raw` y conserva el resto verbatim', async () => {
        replyWith(subResponse())

        const provider = new ConfioProvider()
        const result = await provider.createSubscription({ planName: PLAN, buyer: buyer() })

        // El link es portador: quien lo tenga registra una tarjeta. Vive en UN
        // solo campo para que un `metadata: result.raw` aguas abajo no lo persista.
        expect(result.raw).not.toHaveProperty('acceptanceUrl')
        expect(JSON.stringify(result.raw)).not.toContain('abc123token')
        const { acceptanceUrl: _omitido, ...resto } = subResponse()
        expect(result.raw).toEqual(resto)
      })

      it('mapea una respuesta TRIALING: períodos y próximo cobro como Date, sin link', async () => {
        replyWith(
          subResponse({
            status: 'TRIALING',
            acceptanceUrl: undefined,
            acceptanceExpireTime: undefined,
            currentPeriodStart: '2026-08-26T10:30:00Z',
            currentPeriodEnd: '2026-09-10T10:30:00Z',
            nextBillingTime: '2026-09-10T10:30:00Z',
          }),
        )

        const provider = new ConfioProvider()
        const result = await provider.createSubscription({ planName: PLAN, buyer: buyer() })

        expect(result.status).toBe('TRIALING')
        expect(result.acceptanceUrl).toBeUndefined()
        expect(result.currentPeriodStart).toEqual(new Date('2026-08-26T10:30:00Z'))
        expect(result.currentPeriodEnd).toEqual(new Date('2026-09-10T10:30:00Z'))
        expect(result.nextBillingTime).toEqual(new Date('2026-09-10T10:30:00Z'))
      })

      it('deja pasar un estado que no conocemos en vez de romper el parseo', async () => {
        replyWith(subResponse({ status: 'FROZEN' }))

        const provider = new ConfioProvider()
        const result = await provider.createSubscription({ planName: PLAN, buyer: buyer() })

        expect(result.status).toBe('FROZEN')
      })

      it.each([
        [{ ...buyer(), email: '' }, 'buyer.email'],
        [{ ...buyer(), email: 'sin-arroba' }, 'buyer.email'],
        [{ ...buyer(), firstName: 'Jo' }, 'buyer.firstName'],
        [{ ...buyer(), lastName: '  ' }, 'buyer.lastName'],
        [{ ...buyer(), phoneNumber: '123' }, 'buyer.phoneNumber'],
      ])('rechaza un buyer inválido ANTES de tocar la red (%#) nombrando el campo', async (bad, field) => {
        const provider = new ConfioProvider()

        await expect(
          provider.createSubscription({ planName: PLAN, buyer: bad as any }),
        ).rejects.toBeInstanceOf(ConfioSubscriptionInputError)
        // Nada salió por la red: la guarda corta antes del fetch.
        expect(received).toHaveLength(0)

        const err = await rechazo(provider.createSubscription({ planName: PLAN, buyer: bad as any }))
        expect(err.code).toBe('invalid_buyer')
        expect(err.field).toBe(field)
      })

      /**
       * CAMBIO DE CONTRATO: antes esta guarda normalizaba un local colombiano a
       * `+57…`. Ahora el borde delega en `confio-buyer.ts`, que NO asume ningún
       * país: acá no hay `callingCode` que aportar —el país lo trae el usuario
       * desde backend-auth, no una constante nuestra—, así que un local suelto
       * se rechaza en vez de convertirse en un contacto adivinado pegado a un
       * cobro que se repite todos los meses.
       */
      it('rechaza un teléfono local suelto: en el borde no se inventa el país', async () => {
        replyWith(subResponse())

        const provider = new ConfioProvider()
        const err = await rechazo(
          provider.createSubscription({
            planName: PLAN,
            buyer: { ...buyer(), phoneNumber: '3001234567' },
          }),
        )

        expect(err).toBeInstanceOf(ConfioSubscriptionInputError)
        expect(err.code).toBe('invalid_buyer')
        expect(err.field).toBe('buyer.phoneNumber')
        expect(err.message).not.toContain('+573215786325')
        // Nada salió por la red: el rechazo es ANTES del fetch.
        expect(received).toHaveLength(0)
      })

      it('rechaza un plan de OTRO store sin pegarle a la red', async () => {
        const provider = new ConfioProvider()

        const err = await rechazo(
          provider.createSubscription({
            planName: 'stores/01OTROSTORE/subscription-plans/01PLAN',
            buyer: buyer(),
          }),
        )

        expect(err).toBeInstanceOf(ConfioSubscriptionInputError)
        expect(err.code).toBe('plan_store_mismatch')
        expect(received).toHaveLength(0)
      })

      it('rechaza la firma compartida de PaymentProvider (sin planName ni buyer)', async () => {
        const provider = new ConfioProvider()

        const err = await rechazo(
          provider.createSubscription({
            brandId: 'b1',
            userId: 'u1',
            planSlug: 'dropi-roax',
            priceAmount: 19900,
            currency: 'COP',
          }),
        )

        expect(err).toBeInstanceOf(ConfioSubscriptionInputError)
        expect(err.code).toBe('missing_buyer_or_plan')
        expect(received).toHaveLength(0)
      })

      it('propaga el 4xx de ConfioPagos con su cuerpo', async () => {
        replyWith({ message: 'buyer.firstName: must be at least 3 characters' }, 422)

        const provider = new ConfioProvider()
        await expect(
          provider.createSubscription({ planName: PLAN, buyer: buyer() }),
        ).rejects.toThrow(/ConfioPagos error 422/)
      })
    })

    describe('getSubscription', () => {
      it('GETea el resource name completo tal cual', async () => {
        replyWith(subResponse({ status: 'TRIALING', acceptanceUrl: undefined }))

        const provider = new ConfioProvider()
        const result = await provider.getSubscription(SUB)

        expect(received).toHaveLength(1)
        expect(received[0].method).toBe('GET')
        expect(received[0].url).toBe(
          '/v1/stores/01TESTSTORE/subscription-plans/01PLAN/subscriptions/01SUB',
        )
        expect(result.providerSubscriptionId).toBe(SUB)
        expect(result.status).toBe('TRIALING')
      })

      it('recorta el prefijo `organizations/…` con el que Confío devuelve algunos names', async () => {
        replyWith(subResponse())

        const provider = new ConfioProvider()
        await provider.getSubscription(`organizations/01ORG/${SUB}`)

        expect(received[0].url).toBe(
          '/v1/stores/01TESTSTORE/subscription-plans/01PLAN/subscriptions/01SUB',
        )
      })

      it('rechaza un id suelto: de ahí no se puede componer la ruta', async () => {
        const provider = new ConfioProvider()

        const err = await rechazo(provider.getSubscription('01SUB'))

        expect(err).toBeInstanceOf(ConfioSubscriptionInputError)
        expect(err.code).toBe('invalid_subscription_name')
        expect(received).toHaveLength(0)
      })

      it('lanza si el provider no está configurado', async () => {
        process.env.CONFIO_STORE_ID = ''
        process.env.CONFIO_ACCESS_TOKEN = ''

        const provider = new ConfioProvider()
        await expect(provider.getSubscription(SUB)).rejects.toThrow(/no configurado/)
        expect(received).toHaveLength(0)
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
