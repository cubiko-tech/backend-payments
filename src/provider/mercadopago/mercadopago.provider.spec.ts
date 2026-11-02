import { createHmac } from 'crypto'
import { MercadoPagoApiError, MercadoPagoProvider } from './mercadopago.provider'

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

describe('MercadoPagoProvider - getPaymentStatus', () => {
  const originalEnv = process.env
  const answer = (body: unknown, status = 200) =>
    // R17: Mercado Pago is a third party; a real Response keeps what the client reads honest.
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(body), { status }))

  beforeEach(() => {
    process.env = { ...originalEnv, MP_ACCESS_TOKEN: 'mp-test-token' }
  })

  afterEach(() => {
    process.env = originalEnv
    jest.restoreAllMocks()
  })

  it('searches by the payment reference, not by the preference id it keeps', async () => {
    // R15: red if the client asks /v1/payments/<id> again: a preference never reads as paid.
    const fetchMock = answer({ results: [{ status: 'approved', transaction_amount: 19900 }] })

    const result = await new MercadoPagoProvider().getPaymentStatus('pref-1', 'pay-1')

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.mercadopago.com/v1/payments/search?external_reference=pay-1&limit=50',
    )
    expect(result.status).toBe('completed')
    expect(result.metadata?.transactionAmount).toBe(19900)
  })

  it('sends our payment id as the reference when creating the checkout', async () => {
    // R15: red if the reference stops being our id: the search can never find the payment.
    const fetchMock = answer({ id: 'pref-1', init_point: 'https://mp.invalid' })

    await new MercadoPagoProvider().createCheckout({
      amount: 100,
      currency: 'COP',
      brandId: 'b',
      userId: 'u',
      purpose: 'plan_purchase',
      metadata: { paymentId: 'pay-1' },
    })

    const sent = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(sent.external_reference).toBe('pay-1')
  })

  it.each([
    {
      name: 'an approved attempt over a rejected one',
      statuses: ['rejected', 'approved'],
      want: 'completed',
    },
    {
      name: 'a refund over a live attempt',
      statuses: ['in_process', 'refunded'],
      want: 'refunded',
    },
    { name: 'a live attempt', statuses: ['rejected', 'in_process'], want: 'processing' },
    { name: 'only rejected attempts', statuses: ['rejected'], want: 'pending' },
    { name: 'no attempts', statuses: [], want: 'pending' },
  ])('answers $want for $name', async ({ statuses, want }) => {
    // R15: red if the first result decides: an approved payment behind a rejected one is missed.
    answer({ results: statuses.map((status) => ({ status })) })

    expect((await new MercadoPagoProvider().getPaymentStatus('pref-1', 'pay-1')).status).toBe(want)
  })

  it('E7 throws with the status on an error answer, also with a body that is not JSON', async () => {
    // R15: red if the client swallows errors into pending: an outage reads as not paid.
    // R17: A real Response, because a gateway error page is what breaks parsing first.
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response('<html>Bad gateway</html>', { status: 502 }))

    const failure = new MercadoPagoProvider().getPaymentStatus('pref-1', 'pay-1')

    await expect(failure).rejects.toBeInstanceOf(MercadoPagoApiError)
    await expect(failure).rejects.toMatchObject({ status: 502 })
  })

  it('E7 throws when the network is down', async () => {
    // R15: red if the client swallows errors into pending: an outage reads as not paid.
    // R17: Refusing the connection is how the whole API being down reaches this client.
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    await expect(new MercadoPagoProvider().getPaymentStatus('pref-1', 'pay-1')).rejects.toThrow(
      'fetch failed',
    )
  })

  it('throws on an answer without a results list instead of reading it as no payment', async () => {
    // R15: red without the list check: an answer of another shape would expire a paid payment.
    answer({ unexpected: true })

    await expect(new MercadoPagoProvider().getPaymentStatus('pref-1', 'pay-1')).rejects.toThrow(
      'no results list',
    )
  })
})
