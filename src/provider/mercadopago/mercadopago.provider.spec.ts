import { createHmac } from 'crypto'
import { MercadoPagoProvider } from './mercadopago.provider'

const PAYLOAD = Buffer.from('{"data":{"id":"mp_pay_123"}}', 'utf8')
const TIMESTAMP = '1700000000'
const MANIFEST = `id:mp_pay_123;request-id:;ts:${TIMESTAMP};`

function signManifest(secret: string): string {
  const hash = createHmac('sha256', secret).update(MANIFEST).digest('hex')
  return `ts=${TIMESTAMP},v1=${hash}`
}

describe('MercadoPagoProvider - validateWebhookSignature', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('accepts a valid manifest signature when MP_WEBHOOK_SECRET is configured', () => {
    process.env.MP_WEBHOOK_SECRET = 'mp-webhook-secret-test'
    const provider = new MercadoPagoProvider()

    expect(provider.validateWebhookSignature(PAYLOAD, signManifest('mp-webhook-secret-test'))).toBe(
      true,
    )
  })

  it('rejects when MP_WEBHOOK_SECRET is not configured', () => {
    delete process.env.MP_WEBHOOK_SECRET
    const provider = new MercadoPagoProvider()

    expect(provider.validateWebhookSignature(PAYLOAD, signManifest('mp-webhook-secret-test'))).toBe(
      false,
    )
  })

  it('rejects a webhook signed with CHANGEME when MP_WEBHOOK_SECRET is CHANGEME', () => {
    process.env.MP_WEBHOOK_SECRET = 'CHANGEME'
    const provider = new MercadoPagoProvider()

    expect(provider.validateWebhookSignature(PAYLOAD, signManifest('CHANGEME'))).toBe(false)
  })
})
