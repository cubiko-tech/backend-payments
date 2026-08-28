import { Test, TestingModule } from '@nestjs/testing'
import { HttpException, Logger, RawBodyRequest } from '@nestjs/common'
import { Request } from 'express'

import { WebhookController } from './webhook.controller'
import { WebhookService } from './webhook.service'
import { StripeProvider } from '../provider/stripe/stripe.provider'
import { MercadoPagoProvider } from '../provider/mercadopago/mercadopago.provider'
import { DropiProvider } from '../provider/dropi/dropi.provider'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { buildConfioWebhookEventId } from '../provider/confio/confio-webhook'

/**
 * Capa 2: el handler real de `POST /webhook/confio`, con el reparto entre el
 * bearer (que compara el controller) y la firma (que verifica el módulo puro).
 *
 * Los checksums viajan como CONSTANTES LITERALES precalculadas fuera del test
 * —misma regla que `confio-webhook-signature.spec.ts`—: el test nunca llama a
 * `createHash` ni a la implementación para armar lo que después compara.
 * Receta: SHA256(data[prop1] + … + timestamp + WEBHOOK_KEY), orden exacto de
 * `signature.properties`, sin separador, hexadecimal en MAYÚSCULA.
 */
const WEBHOOK_KEY = 'test-webhook-key'
const ACCESS_TOKEN = 'access-token-de-confio'
const TIMESTAMP = 1768384800
const SUBSCRIPTION =
  'stores/01KZBY100Z3HD2X997XE0DN8PW/subscription-plans/01M0Z020DYMXKKDHHR4HAX916R/subscriptions/01M0Z0AAAA'
const PROPS_COBRO = ['name', 'cycleNumber', 'amountCents', 'currencyCode', 'status', 'payment']

/** Ciclo 3, `payments/p3`, firmado con `test-webhook-key`. */
const CHECKSUM_CICLO_3 = 'A1E94735E7AFC799304EC6ADEC616F533A815C5FEAF52B835E1F3F4F8E84DF25'
/** Ciclo 4, `payments/p4`, firmado con `test-webhook-key`. */
const CHECKSUM_CICLO_4 = 'AF033FEC021047858E2463C0E8CAFCD7AE63E44EDCF3C02C088D39E59502CCF9'
/** Ciclo 3, `payments/p3`, firmado DE VERDAD con la clave literal `CHANGEME`. */
const CHECKSUM_CICLO_3_CHANGEME = '2038A06AB3F6EC2A0D608B55E345882EB8D24BF247D3C786178D2A748A6922EB'

const CHECKSUM_POR_CICLO: Record<number, string> = { 3: CHECKSUM_CICLO_3, 4: CHECKSUM_CICLO_4 }

/** Cobro de suscripción: el ramo FIRMADO, el que trae objeto `signature`. */
function cobroFirmado(cycleNumber: number, checksum = CHECKSUM_POR_CICLO[cycleNumber]) {
  return {
    event: 'subscription.billingStatusChanged',
    data: {
      name: SUBSCRIPTION,
      payment: `organizations/o/stores/s/payments/p${cycleNumber}`,
      cycleNumber,
      amountCents: 5000000,
      currencyCode: 'COP',
      status: 'SUCCEEDED',
      createTime: '2026-01-14T10:00:00Z',
    },
    timestamp: TIMESTAMP,
    signature: { properties: [...PROPS_COBRO], checksum },
  }
}

/** Link de pago one-shot: tráfico VIVO, llega sin objeto `signature`. */
function pagoOneShot() {
  return {
    event: 'payment.statusChanged',
    data: { name: 'stores/01KZBY100Z3HD2X997XE0DN8PW/payments/01M0Z0BBBB', status: 'FUNDED' },
    timestamp: TIMESTAMP,
  }
}

/** Request con `rawBody`, que es lo único que el handler lee del pedido. */
function reqCon(payload: unknown): RawBodyRequest<Request> {
  return reqCrudo(JSON.stringify(payload))
}

function reqCrudo(raw: string): RawBodyRequest<Request> {
  return { rawBody: Buffer.from(raw) } as RawBodyRequest<Request>
}

/**
 * Estado HTTP observable de una llamada al handler: 200 si resolvió, el status
 * de la `HttpException` si rechazó, y 500 ante cualquier otra excepción — así
 * un `JSON.parse` sin proteger sale como 500 en vez de pasar por un 401.
 */
async function estadoHttp(llamada: () => Promise<unknown>): Promise<number> {
  try {
    await llamada()

    return 200
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : 500
  }
}

const CLAVES_DE_ENTORNO = ['ENV', 'GO_ENV', 'NODE_ENV', 'CONFIO_WEBHOOK_KEY']

type EntornoDePrueba = Partial<Record<(typeof CLAVES_DE_ENTORNO)[number], string>>

interface Armado {
  controller: WebhookController
  receive: jest.Mock
  warn: jest.SpyInstance
  error: jest.SpyInstance
}

/**
 * Construye el controller con un entorno dado. El entorno se lee UNA VEZ al
 * construir (igual que `ConfioProvider`), así que cada caso arma el suyo.
 *
 * Doble de `ConfioProvider` justificado (R17): el proveedor real lee
 * `process.env` al construirse y habla por red. El doble reproduce EXACTAMENTE
 * la única conducta que el ramo one-shot todavía le delega —comparar el bearer
 * contra `CONFIO_ACCESS_TOKEN`— y nada más.
 */
async function construirController(entorno: EntornoDePrueba): Promise<Armado> {
  for (const clave of CLAVES_DE_ENTORNO) delete process.env[clave]
  Object.assign(process.env, entorno)

  const receive = jest.fn().mockResolvedValue({ data: {} })
  const confioProvider = {
    validateWebhookSignature: (_raw: Buffer, token: string) => token === ACCESS_TOKEN,
  }

  const module: TestingModule = await Test.createTestingModule({
    controllers: [WebhookController],
    providers: [
      { provide: WebhookService, useValue: { receive } },
      { provide: StripeProvider, useValue: {} },
      { provide: MercadoPagoProvider, useValue: {} },
      { provide: DropiProvider, useValue: {} },
      { provide: ConfioProvider, useValue: confioProvider },
    ],
  }).compile()

  return {
    controller: module.get<WebhookController>(WebhookController),
    receive,
    warn: jest.spyOn(Logger.prototype, 'warn').mockImplementation(),
    error: jest.spyOn(Logger.prototype, 'error').mockImplementation(),
  }
}

/** Concatena las llamadas de un spy de log para poder afirmar sobre la línea. */
function lineas(spy: jest.SpyInstance): string {
  return spy.mock.calls.map((call) => String(call[0])).join('\n')
}

describe('WebhookController (confio)', () => {
  const original: NodeJS.ProcessEnv = {}

  beforeEach(() => {
    for (const clave of CLAVES_DE_ENTORNO) original[clave] = process.env[clave]
  })

  afterEach(() => {
    for (const clave of CLAVES_DE_ENTORNO) {
      if (original[clave] === undefined) delete process.env[clave]
      else process.env[clave] = original[clave]
    }
    jest.restoreAllMocks()
  })

  describe('ramo firmado, con la clave configurada', () => {
    it('despacha el cobro firmado y acuña una clave por ciclo', async () => {
      const { controller, receive } = await construirController({
        ENV: 'production',
        CONFIO_WEBHOOK_KEY: WEBHOOK_KEY,
      })

      await controller.confio(`Bearer ${WEBHOOK_KEY}`, reqCon(cobroFirmado(3)))
      await controller.confio(`Bearer ${WEBHOOK_KEY}`, reqCon(cobroFirmado(4)))

      const [primera, segunda] = receive.mock.calls.map((call) => call[2])
      expect(primera).toBe(buildConfioWebhookEventId(cobroFirmado(3) as never))
      expect(primera).not.toEqual(segunda)
    })

    it('rechaza el checksum adulterado con una línea que lleva properties y las claves de data', async () => {
      const { controller, receive, warn } = await construirController({
        ENV: 'production',
        CONFIO_WEBHOOK_KEY: WEBHOOK_KEY,
      })
      const adulterado = cobroFirmado(3, CHECKSUM_CICLO_4)

      const estado = await estadoHttp(() =>
        controller.confio(`Bearer ${WEBHOOK_KEY}`, reqCon(adulterado)),
      )

      expect(estado).toBe(401)
      expect(receive).not.toHaveBeenCalled()
      const linea = lineas(warn)
      expect(linea).toContain('checksum_mismatch')
      expect(linea).toContain('cycleNumber')
      expect(linea).toContain('createTime')
    })

    // Mitad 1 de la asimetría del bearer: el ramo firmado NO acepta el access token.
    it('rechaza el evento firmado que llega con el access token como bearer', async () => {
      const { controller, receive, warn } = await construirController({
        ENV: 'production',
        CONFIO_WEBHOOK_KEY: WEBHOOK_KEY,
      })

      const estado = await estadoHttp(() =>
        controller.confio(`Bearer ${ACCESS_TOKEN}`, reqCon(cobroFirmado(3))),
      )

      expect(estado).toBe(401)
      expect(receive).not.toHaveBeenCalled()
      expect(lineas(warn)).toContain('bearer_mismatch')
    })
  })

  describe('ramo one-shot (tráfico vivo del link de pago)', () => {
    // Mitad 2 de la asimetría: el ramo one-shot SÍ acepta la clave de webhook,
    // para que provisionarla no apague cobros en vuelo.
    it('acepta la clave de webhook como bearer', async () => {
      const { controller, receive } = await construirController({
        ENV: 'production',
        CONFIO_WEBHOOK_KEY: WEBHOOK_KEY,
      })

      const estado = await estadoHttp(() =>
        controller.confio(`Bearer ${WEBHOOK_KEY}`, reqCon(pagoOneShot())),
      )

      expect(estado).toBe(200)
      expect(receive).toHaveBeenCalledTimes(1)
    })

    it('sigue aceptando el access token sin clave de webhook, aun en producción', async () => {
      const { controller, receive } = await construirController({ ENV: 'production' })

      const estado = await estadoHttp(() =>
        controller.confio(`Bearer ${ACCESS_TOKEN}`, reqCon(pagoOneShot())),
      )

      expect(estado).toBe(200)
      expect(receive.mock.calls[0][2]).toBe(
        'stores/01KZBY100Z3HD2X997XE0DN8PW/payments/01M0Z0BBBB:FUNDED',
      )
    })

    it('rechaza el bearer que no es ninguno de los dos y no inventa campos de firma', async () => {
      const { controller, receive, warn } = await construirController({
        ENV: 'production',
        CONFIO_WEBHOOK_KEY: WEBHOOK_KEY,
      })

      const estado = await estadoHttp(() => controller.confio('Bearer basura', reqCon(pagoOneShot())))

      expect(estado).toBe(401)
      expect(receive).not.toHaveBeenCalled()
      const linea = lineas(warn)
      expect(linea).toContain('bearer_mismatch')
      expect(linea).toContain('no aplica')
    })
  })

  describe('ramo firmado, sin clave configurada', () => {
    it.each([['ENV'], ['GO_ENV'], ['NODE_ENV']])(
      'rechaza con log de error en producción declarada por %s',
      async (grafia) => {
        const { controller, receive, error } = await construirController({ [grafia]: 'production' })

        const estado = await estadoHttp(() =>
          controller.confio(`Bearer ${ACCESS_TOKEN}`, reqCon(cobroFirmado(3))),
        )

        expect(estado).toBe(401)
        expect(receive).not.toHaveBeenCalled()
        expect(lineas(error)).toContain('missing_key')
      },
    )

    // El fail-open de dev/stg se cerró cuando `subscriptionStatusChanged` pasó a
    // tener efecto CROSS-SERVICE: un `CANCELED` sin autenticar ya no mueve sólo
    // una columna local, revoca el plan de la marca en backend-roles.
    it.each([['development'], ['staging']])(
      'también rechaza en %s: sin clave no se acepta el ramo firmado en ningún ambiente',
      async (ambiente) => {
        const { controller, receive, error } = await construirController({ ENV: ambiente })

        const estado = await estadoHttp(() =>
          controller.confio('Bearer basura', reqCon(cobroFirmado(3))),
        )

        expect(estado).toBe(401)
        expect(receive).not.toHaveBeenCalled()
        expect(lineas(error)).toContain('missing_key')
      },
    )

    it('el ramo one-shot NO queda apagado por la clave ausente fuera de producción', async () => {
      const { controller, receive } = await construirController({ ENV: 'development' })

      const estado = await estadoHttp(() =>
        controller.confio(`Bearer ${ACCESS_TOKEN}`, reqCon(pagoOneShot())),
      )

      expect(estado).toBe(200)
      expect(receive).toHaveBeenCalledTimes(1)
    })

    it('trata CHANGEME como no configurada aunque el payload venga firmado con CHANGEME', async () => {
      const { controller, receive, error } = await construirController({
        ENV: 'production',
        CONFIO_WEBHOOK_KEY: 'CHANGEME',
      })
      const firmadoConChangeme = cobroFirmado(3, CHECKSUM_CICLO_3_CHANGEME)

      const estado = await estadoHttp(() =>
        controller.confio('Bearer CHANGEME', reqCon(firmadoConChangeme)),
      )

      expect(estado).toBe(401)
      expect(receive).not.toHaveBeenCalled()
      expect(lineas(error)).toContain('missing_key')
    })
  })

  describe('cuerpos que no son un objeto JSON', () => {
    it.each([['null'], ['[]'], ['"x"'], ['{']])('rechaza %s con 401 y nunca con 500', async (body) => {
      const { controller, receive, warn } = await construirController({
        ENV: 'production',
        CONFIO_WEBHOOK_KEY: WEBHOOK_KEY,
      })

      const estado = await estadoHttp(() =>
        controller.confio(`Bearer ${WEBHOOK_KEY}`, reqCrudo(body)),
      )

      expect(estado).toBe(401)
      expect(receive).not.toHaveBeenCalled()
      expect(lineas(warn)).toContain('invalid_json')
    })
  })

  describe('eventos fuera del contrato', () => {
    it('responde 200 ignorado sin despachar', async () => {
      const { controller, receive } = await construirController({
        ENV: 'production',
        CONFIO_WEBHOOK_KEY: WEBHOOK_KEY,
      })

      const respuesta = await controller.confio(
        `Bearer ${WEBHOOK_KEY}`,
        reqCon({ event: 'invoice.created', data: { name: 'x' }, timestamp: TIMESTAMP }),
      )

      expect(respuesta).toEqual({ ignored: true })
      expect(receive).not.toHaveBeenCalled()
    })
  })
})
