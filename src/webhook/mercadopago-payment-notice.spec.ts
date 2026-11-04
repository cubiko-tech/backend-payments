import { Logger } from '@nestjs/common'
import { Payment, PaymentProvider, PaymentStatus } from '../payment/entities/payment.entity'
import {
  MercadoPagoApiError,
  MercadoPagoProvider,
} from '../provider/mercadopago/mercadopago.provider'
import { resolveMercadoPagoNotice } from './mercadopago-payment-notice'

const PAYMENT_ID = '22222222-2222-4222-8222-222222222222'
const MP_PAYMENT_ID = '987654321'

function answerMp(body: unknown, status = 200): jest.SpyInstance {
  // R17: External paid API; exercises the real MercadoPagoProvider HTTP path up to global.fetch.
  return jest.spyOn(global, 'fetch').mockImplementation(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

function repoWith(payment: Partial<Payment> | null) {
  // R17: Minimal repository lookup double for unit-testing the decision table without opening a real DB.
  return {
    findOne: jest.fn().mockResolvedValue(payment),
  }
}

describe('resolveMercadoPagoNotice', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, MP_ACCESS_TOKEN: 'APP_USR-test-token' }
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env = originalEnv
    jest.restoreAllMocks()
  })

  it('throws when GET /v1/payments/{id} returns a non-2xx error or network failure', async () => {
    // R15: red if an outage is swallowed as null: the event would be marked PROCESSED instead of FAILED.
    answerMp('<html>Bad gateway</html>', 502)
    const repo = repoWith(null)

    await expect(
      resolveMercadoPagoNotice(new MercadoPagoProvider(), repo, MP_PAYMENT_ID),
    ).rejects.toBeInstanceOf(MercadoPagoApiError)
    expect(repo.findOne).not.toHaveBeenCalled()
  })

  it('throws when the response body omits status', async () => {
    // R15: red if a malformed payload without status is treated as unapproved instead of failing.
    answerMp({ id: MP_PAYMENT_ID, external_reference: PAYMENT_ID })
    const repo = repoWith(null)

    await expect(
      resolveMercadoPagoNotice(new MercadoPagoProvider(), repo, MP_PAYMENT_ID),
    ).rejects.toThrow('returned no status')
    expect(repo.findOne).not.toHaveBeenCalled()
  })

  it.each([
    'pending',
    'in_process',
    'authorized',
    'rejected',
    'cancelled',
    'refunded',
    'charged_back',
  ])('returns null without querying payments when status is %s', async (status) => {
    // R15: red if non-approved statuses proceed to resolve and complete the payment.
    answerMp({
      id: MP_PAYMENT_ID,
      status,
      external_reference: PAYMENT_ID,
      transaction_amount: 50000,
    })
    const repo = repoWith({
      id: PAYMENT_ID,
      provider: PaymentProvider.MERCADOPAGO,
      status: PaymentStatus.PENDING,
    })

    const res = await resolveMercadoPagoNotice(new MercadoPagoProvider(), repo, MP_PAYMENT_ID)

    expect(res).toBeNull()
    expect(repo.findOne).not.toHaveBeenCalled()
  })

  it.each([null, '', 'not-a-uuid', 'brand-1:plan-pro'])(
    'returns null without querying payments when external_reference is %s',
    async (externalReference) => {
      // R15: red if a non-UUID external_reference reaches Postgres and triggers 22P02.
      answerMp({
        id: MP_PAYMENT_ID,
        status: 'approved',
        external_reference: externalReference,
        transaction_amount: 50000,
      })
      const repo = repoWith(null)

      const res = await resolveMercadoPagoNotice(new MercadoPagoProvider(), repo, MP_PAYMENT_ID)

      expect(res).toBeNull()
      expect(repo.findOne).not.toHaveBeenCalled()
    },
  )

  it('returns null when no Payment exists for external_reference', async () => {
    // R15: red if a missing row still returns a paymentId to complete.
    answerMp({
      id: MP_PAYMENT_ID,
      status: 'approved',
      external_reference: PAYMENT_ID,
      transaction_amount: 50000,
    })
    const repo = repoWith(null)

    const res = await resolveMercadoPagoNotice(new MercadoPagoProvider(), repo, MP_PAYMENT_ID)

    expect(res).toBeNull()
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: PAYMENT_ID } })
  })

  it('returns null when the Payment belongs to another provider', async () => {
    // R15: red if a Mercado Pago notice is allowed to complete a Stripe or Dropi payment.
    answerMp({
      id: MP_PAYMENT_ID,
      status: 'approved',
      external_reference: PAYMENT_ID,
      transaction_amount: 50000,
    })
    const repo = repoWith({
      id: PAYMENT_ID,
      provider: PaymentProvider.DROPI,
      status: PaymentStatus.PENDING,
    })

    const res = await resolveMercadoPagoNotice(new MercadoPagoProvider(), repo, MP_PAYMENT_ID)

    expect(res).toBeNull()
  })

  it('returns paymentId and providerData with transactionAmount when status is approved for a Mercado Pago payment', async () => {
    // R15: red if external_reference or transaction_amount is dropped from the resolved payload.
    const fetchSpy = answerMp({
      id: MP_PAYMENT_ID,
      status: 'approved',
      external_reference: PAYMENT_ID,
      transaction_amount: 50000,
    })
    const repo = repoWith({
      id: PAYMENT_ID,
      provider: PaymentProvider.MERCADOPAGO,
      status: PaymentStatus.PENDING,
    })

    const res = await resolveMercadoPagoNotice(new MercadoPagoProvider(), repo, MP_PAYMENT_ID)

    expect(fetchSpy.mock.calls[0][0]).toBe(
      `https://api.mercadopago.com/v1/payments/${MP_PAYMENT_ID}`,
    )
    expect(res).toEqual({
      paymentId: PAYMENT_ID,
      providerData: {
        mpPaymentId: MP_PAYMENT_ID,
        providerStatus: {
          status: 'approved',
          transactionAmount: 50000,
        },
      },
    })
  })
})
