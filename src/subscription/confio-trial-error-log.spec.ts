import { HttpStatus, Logger } from '@nestjs/common'

import { ClientAuthService } from '../client/client-auth.service'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { ConfioPlanService } from '../provider/confio/confio-plan.service'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { ProviderPaymentNotFoundError } from '../provider/provider.interface'
import { RequestException } from '../shared/exception/request.exception'
import { ConfioCancellationService } from './confio-cancellation.service'
import { ConfioTrialService } from './confio-trial.service'

const REAL_FETCH = global.fetch
const CONFIO_PLAN = 'stores/01TESTSTORE/subscription-plans/01PLAN'
const BUYER_BODY = JSON.stringify({ buyer: { email: 'a@b.co', document: '123' } })

/** The fake ConfioPagos: every call answers `status` with `body`. */
function confioAnswers(status: number, body: string): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status < 400,
    status,
    text: async () => body,
  }) as unknown as typeof fetch
}

/**
 * Doubles (R17): platform, roles, auth and the plan map are other services this case does not
 * exercise, so they answer the happy path. `ConfioProvider` is the real one; only `fetch` is fake.
 */
function trialServiceWithRealProvider(): ConfioTrialService {
  const ok = <T>(value: T) => jest.fn().mockResolvedValue(value)
  const contact = { email: 'a@b.co', name: 'Ana Gomez', phone: '3215786325', callingCode: '57' }

  return new ConfioTrialService(
    { resolveBrandCountry: ok({ ok: true, country: 'CO' }) } as unknown as ClientPlatformService,
    {
      resolvePriceForCountry: ok({ ok: true, price: { currency: 'COP', price: 19900 } }),
    } as unknown as ClientRolesService,
    { resolveBuyerContact: ok({ ok: true, contact }) } as unknown as ClientAuthService,
    { resolveConfioPlanName: ok(CONFIO_PLAN) } as unknown as ConfioPlanService,
    new ConfioProvider(),
    { cancel: ok(undefined) } as unknown as ConfioCancellationService,
  )
}

describe('ConfioPagos error body stays out of the logs', () => {
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
    global.fetch = REAL_FETCH
    jest.restoreAllMocks()
  })

  it('logs the 400 status of a failed signup, without the buyer email or document', async () => {
    // Red if `confioFetch` puts the response body back into the error: the email shows up.
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation()
    confioAnswers(400, BUYER_BODY)

    const failure = await trialServiceWithRealProvider()
      .createForTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro', conPrueba: true })
      .catch((error) => error)

    expect(failure).toBeInstanceOf(RequestException)
    expect(failure.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    const lines = errorSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(lines).toContain('ConfioPagos error 400')
    expect(lines).not.toContain('a@b.co')
    expect(lines).not.toContain('"document"')
  })

  it('keeps the 404 class and status without the response body', async () => {
    // Red if the 404 branch puts the response text back into the message.
    confioAnswers(404, BUYER_BODY)

    const failure = await new ConfioProvider()
      .getPaymentStatus('stores/01TESTSTORE/payments/01PAY')
      .catch((error) => error)

    expect(failure).toBeInstanceOf(ProviderPaymentNotFoundError)
    expect(failure.message).toBe('ConfioPagos error 404')
  })

  it('reports the status of a non-JSON answer without its text', async () => {
    // Red if the non-JSON branch puts the response text back into the message.
    confioAnswers(502, 'buyer a@b.co rejected')

    const failure = await new ConfioProvider()
      .getPaymentStatus('stores/01TESTSTORE/payments/01PAY')
      .catch((error) => error)

    expect(failure.message).toContain('502')
    expect(failure.message).not.toContain('a@b.co')
  })
})
