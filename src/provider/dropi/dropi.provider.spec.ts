import * as crypto from 'crypto'
import { DropiProvider } from './dropi.provider'

const WEBHOOK_SECRET = 'dropi-webhook-secret-test'
const PAYLOAD = Buffer.from('{"event":"charge.paid","chargeId":"ch_123","amount":50000}', 'utf8')
const VALID_SIGNATURE = '2d00cac159bb9ea525e98635701a37e4826ec586f0b325bab3497fe7cdf9ac33'

describe('DropiProvider — validateWebhookSignature', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      DROPI_WEBHOOK_SECRET: WEBHOOK_SECRET,
    }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
    jest.restoreAllMocks()
  })

  it('acepta una firma HMAC-SHA256 válida para el cuerpo con DROPI_WEBHOOK_SECRET', () => {
    const provider = new DropiProvider()

    expect(provider.validateWebhookSignature(PAYLOAD, VALID_SIGNATURE)).toBe(true)
  })

  it('rechaza una firma alterada en un carácter', () => {
    const provider = new DropiProvider()
    const alteredSignature = `${VALID_SIGNATURE.slice(0, -1)}4`

    expect(provider.validateWebhookSignature(PAYLOAD, alteredSignature)).toBe(false)
  })

  it('rechaza una firma de otro largo (10 caracteres) sin lanzar excepción', () => {
    const provider = new DropiProvider()
    const shortSignature = '0123456789'

    expect(() => provider.validateWebhookSignature(PAYLOAD, shortSignature)).not.toThrow()
    expect(provider.validateWebhookSignature(PAYLOAD, shortSignature)).toBe(false)
  })

  it('rechaza una firma de 64 caracteres con multibyte UTF-8 (distinto largo en bytes) sin lanzar', () => {
    const provider = new DropiProvider()
    const multibyteSignature = `${VALID_SIGNATURE.slice(0, -1)}ñ`

    expect(multibyteSignature).toHaveLength(64)
    expect(() => provider.validateWebhookSignature(PAYLOAD, multibyteSignature)).not.toThrow()
    expect(provider.validateWebhookSignature(PAYLOAD, multibyteSignature)).toBe(false)
  })

  it('rechaza cuando DROPI_WEBHOOK_SECRET no está configurado', () => {
    delete process.env.DROPI_WEBHOOK_SECRET
    const provider = new DropiProvider()

    expect(provider.validateWebhookSignature(PAYLOAD, VALID_SIGNATURE)).toBe(false)
  })

  it('compara la firma en tiempo constante mediante crypto.timingSafeEqual', () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual')
    const provider = new DropiProvider()

    const accepted = provider.validateWebhookSignature(PAYLOAD, VALID_SIGNATURE)

    expect(accepted).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    const expectedBuffer = Buffer.from(VALID_SIGNATURE, 'utf8')
    expect(spy).toHaveBeenCalledWith(expectedBuffer, expectedBuffer)

    spy.mockReturnValueOnce(false)
    expect(provider.validateWebhookSignature(PAYLOAD, VALID_SIGNATURE)).toBe(false)
  })
})
