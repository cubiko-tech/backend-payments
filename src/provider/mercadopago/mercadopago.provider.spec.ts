import { createHmac } from 'crypto'
import * as signatureModule from '../confio/confio-webhook-signature'
import {
  MercadoPagoApiError,
  MercadoPagoProvider,
  SIGNATURE_WINDOW_MS,
} from './mercadopago.provider'

// R17: a spyable wrapper around the real primitive, so one case can tell who decides the comparison.
jest.mock('../confio/confio-webhook-signature', () => {
  const actual = jest.requireActual('../confio/confio-webhook-signature')
  return { ...actual, timingSafeEqualStrings: jest.fn(actual.timingSafeEqualStrings) }
})

const SECRET = 'mp-webhook-secret-test'
const PAYLOAD = Buffer.from('{"action":"payment.created","data":{"id":"mp_pay_123"}}', 'utf8')
const TIMESTAMP = 1762250000
const NOW_MS = TIMESTAMP * 1000

function sign(secret: string, ts: number | string = TIMESTAMP, dataId = 'mp_pay_123'): string {
  const manifest = `id:${dataId};request-id:;ts:${ts};`
  const hash = createHmac('sha256', secret).update(manifest).digest('hex')
  return `ts=${ts},v1=${hash}`
}

describe('MercadoPagoProvider - validateWebhookSignature', () => {
  const originalEnv = process.env
  const provider = () => new MercadoPagoProvider()

  beforeEach(() => {
    process.env = { ...originalEnv, MP_WEBHOOK_SECRET: SECRET }
    jest.useFakeTimers({ now: NOW_MS })
  })

  afterEach(() => {
    process.env = originalEnv
    jest.useRealTimers()
    jest.mocked(signatureModule.timingSafeEqualStrings).mockClear()
  })

  it('U1 accepts a fresh valid signature', () => {
    // R15: red if the manifest or the window unit changes: a genuine fresh signature is rejected.
    expect(provider().validateWebhookSignature(PAYLOAD, sign(SECRET))).toBe(true)
  })

  it('rejects when MP_WEBHOOK_SECRET is not configured', () => {
    delete process.env.MP_WEBHOOK_SECRET

    expect(provider().validateWebhookSignature(PAYLOAD, sign(SECRET))).toBe(false)
  })

  it('rejects a webhook signed with CHANGEME when MP_WEBHOOK_SECRET is CHANGEME', () => {
    process.env.MP_WEBHOOK_SECRET = 'CHANGEME'

    expect(provider().validateWebhookSignature(PAYLOAD, sign('CHANGEME'))).toBe(false)
  })

  it('U2 rejects a valid signature whose ts is from 2001', () => {
    // R15: red if the window goes away: a captured signature from 2001 is accepted.
    expect(provider().validateWebhookSignature(PAYLOAD, sign(SECRET, 1000000000))).toBe(false)
  })

  it.each([
    { name: 'exactly the window in the past', offset: -SIGNATURE_WINDOW_MS, want: true },
    { name: 'exactly the window in the future', offset: SIGNATURE_WINDOW_MS, want: true },
    { name: 'one second past the window', offset: -SIGNATURE_WINDOW_MS - 1000, want: false },
    { name: 'one second ahead of the window', offset: SIGNATURE_WINDOW_MS + 1000, want: false },
  ])('U3 answers $want for a ts $name', ({ offset, want }) => {
    // R15: red if the window is dropped or made one-sided: the out-of-window ts is accepted.
    const ts = (NOW_MS + offset) / 1000

    expect(provider().validateWebhookSignature(PAYLOAD, sign(SECRET, ts))).toBe(want)
  })

  it('U4 lets the constant-time primitive decide the comparison', () => {
    // R15: red if the comparison goes back to `===`: the valid signature passes despite the primitive.
    jest.mocked(signatureModule.timingSafeEqualStrings).mockReturnValueOnce(false)

    expect(provider().validateWebhookSignature(PAYLOAD, sign(SECRET))).toBe(false)
  })

  it('U5 rejects a signed body without data.id', () => {
    // R15: red if a missing data.id is signed again as `id:undefined`: the key would not come from it.
    const body = Buffer.from('{"action":"payment.created","data":{}}', 'utf8')

    expect(provider().validateWebhookSignature(body, sign(SECRET, TIMESTAMP, 'undefined'))).toBe(
      false,
    )
  })

  it.each([
    { name: 'a shorter v1', v1: 'abc' },
    { name: 'an altered v1 of the same length', v1: 'f'.repeat(64) },
    { name: 'a multibyte v1', v1: 'ñ'.repeat(32) },
  ])('U6 rejects $name without throwing', ({ v1 }) => {
    const header = `ts=${TIMESTAMP},v1=${v1}`

    expect(() => provider().validateWebhookSignature(PAYLOAD, header)).not.toThrow()
    expect(provider().validateWebhookSignature(PAYLOAD, header)).toBe(false)
  })

  it('U7 rejects a Mercado Pago retry 15 minutes later that keeps the original ts', () => {
    // R15: red if the window is widened past the documented 15-minute retry: the old ts is accepted.
    jest.setSystemTime(NOW_MS + 15 * 60 * 1000)

    expect(provider().validateWebhookSignature(PAYLOAD, sign(SECRET))).toBe(false)
  })

  it('U8 accepts a fresh valid signature whose ts is in milliseconds', () => {
    // R15: red if a 13-digit ts is read as seconds again: every real millisecond notice is rejected.
    expect(provider().validateWebhookSignature(PAYLOAD, sign(SECRET, NOW_MS))).toBe(true)
  })

  it('U9 rejects a valid signature whose ts is from 2001 in milliseconds', () => {
    // R15: red if the window skips millisecond ts: a captured 2001 signature in ms is accepted.
    expect(provider().validateWebhookSignature(PAYLOAD, sign(SECRET, 1000000000000))).toBe(false)
  })

  it.each([
    { name: 'action', body: '{"action":{"toString":1},"data":{"id":"x"}}' },
    { name: 'type', body: '{"type":{"toString":1},"data":{"id":"x"}}' },
    { name: 'data.id', body: '{"action":"payment.created","data":{"id":{"toString":1}}}' },
  ])('U10 rejects an object in $name without throwing', ({ body }) => {
    // R15: red if the field reaches `String()` unchecked: it throws and the route answers 500.
    const payload = Buffer.from(body, 'utf8')

    expect(() => provider().validateWebhookSignature(payload, 'ts=1,v1=a')).not.toThrow()
    expect(provider().validateWebhookSignature(payload, 'ts=1,v1=a')).toBe(false)
  })
})

describe('MercadoPagoProvider - webhookEventId', () => {
  it('builds the key from the signed data.id and ts plus the action', () => {
    // R15: red if the key drops a signed field or the action: two notices would share one row.
    expect(new MercadoPagoProvider().webhookEventId(PAYLOAD, sign(SECRET))).toBe(
      `mp:payment.created:mp_pay_123:${TIMESTAMP}`,
    )
  })

  it('throws when the signed fields cannot be read', () => {
    // R15: red if the null check goes away: a bare TypeError replaces the named error.
    expect(() => new MercadoPagoProvider().webhookEventId(PAYLOAD, 'v1=abc')).toThrow(
      'without signed fields',
    )
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

describe('MercadoPagoProvider - getNoticePayment', () => {
  const originalEnv = process.env
  const answer = (body: unknown) =>
    // R17: Mercado Pago is a third party; a real Response keeps what the client reads honest.
    jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(body), { status: 200 }))

  beforeEach(() => {
    process.env = { ...originalEnv, MP_ACCESS_TOKEN: 'mp-test-token' }
  })

  afterEach(() => {
    process.env = originalEnv
    jest.restoreAllMocks()
  })

  it('reads a null transaction_amount as no amount, not as zero', async () => {
    // R15 (Mutation): reverting to plain Number(transaction_amount) in getNoticePayment returns 0.
    answer({ status: 'approved', external_reference: 'pay-1', transaction_amount: null })

    const notice = await new MercadoPagoProvider().getNoticePayment('mp-1')

    expect(notice.transactionAmount).toBeNull()
  })

  it('keeps a numeric transaction_amount as the confirmed amount', async () => {
    // R15 (Mutation): making getNoticePayment answer null for every amount drops the confirmed 19900.
    answer({ status: 'approved', external_reference: 'pay-1', transaction_amount: 19900 })

    const notice = await new MercadoPagoProvider().getNoticePayment('mp-1')

    expect(notice.transactionAmount).toBe(19900)
  })
})
