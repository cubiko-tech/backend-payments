import { HttpStatus } from '@nestjs/common'

import { ClientAuthService } from '../client/client-auth.service'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { ConfioPlanService } from '../provider/confio/confio-plan.service'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { RequestException } from '../shared/exception/request.exception'
import { ConfioCancellationService } from './confio-cancellation.service'
import { ConfioTrialService } from './confio-trial.service'

const REAL_FETCH = global.fetch
const CONFIO_PLAN = 'stores/01TESTSTORE/subscription-plans/01PLAN'
const INVENTED_PHONE = '+573215786325'
const INVENTED_EMAIL = 'pagos@cubiko.co'

/** The fake ConfioPagos (R17): the real API is external; it accepts every signup. */
function confioAccepts(): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        name: `${CONFIO_PLAN}/subscriptions/01SUB`,
        status: 'PENDING_ACCEPTANCE',
        acceptanceUrl: 'https://pay.dev.confiopagos.com/accept/01SUB',
        createTime: '2026-11-22T00:00:00Z',
      }),
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

type Contact = { email?: string; name?: string; phone?: string; callingCode?: string }

/**
 * Doubles (R17): platform, roles, auth and the plan map are other services; each case sets the
 * country, price row and contact it is about. `ConfioProvider` is the real one; only `fetch` is fake.
 */
function trialService(country: string, currency: string, contact: Contact): ConfioTrialService {
  const ok = <T>(value: T) => jest.fn().mockResolvedValue(value)

  return new ConfioTrialService(
    { resolveBrandCountry: ok({ ok: true, country }) } as unknown as ClientPlatformService,
    {
      resolvePriceForCountry: ok({ ok: true, price: { currency, price: 19900 } }),
    } as unknown as ClientRolesService,
    { resolveBuyerContact: ok({ ok: true, contact }) } as unknown as ClientAuthService,
    { resolveConfioPlanName: ok(CONFIO_PLAN) } as unknown as ConfioPlanService,
    new ConfioProvider(),
    { cancel: ok(undefined) } as unknown as ConfioCancellationService,
  )
}

const signup = (service: ConfioTrialService) =>
  service.createForTrial({ brandId: 'brand-1', userId: 'user-1', planSlug: 'pro', conPrueba: true })

describe('Confio signup contract', () => {
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

  it('rejects a user without a phone with its own 422 and sends no made-up contact', async () => {
    // Mutation: `toE164` in confio-buyer.ts returns '+573215786325' for an empty phone -> red.
    const fetchMock = confioAccepts()
    const contact = { email: 'ana@example.com', name: 'Ana Gomez', callingCode: '57' }

    const failure = await signup(trialService('CO', 'COP', contact)).catch((error) => error)

    expect(failure).toBeInstanceOf(RequestException)
    expect(failure.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(failure.getResponse()).toMatchObject({
      code: 'INVALID_BUYER',
      field: 'buyer.phoneNumber',
    })
    const sent = fetchMock.mock.calls.map((call) => String(call[1]?.body)).join('\n')
    expect(sent).not.toContain(INVENTED_PHONE)
    expect(sent).not.toContain(INVENTED_EMAIL)
  })

  it.each([
    ['CO', 'COP'],
    ['US', 'USD'],
  ])('answers a brand from %s with the currency it charges in, %s', async (country, currency) => {
    // Mutation: `createForTrial` in confio-trial.service.ts returns `currency: undefined` -> red.
    confioAccepts()
    const contact = { email: 'ana@example.com', name: 'Ana Gomez', phone: '+573001234567' }

    const result = await signup(trialService(country, currency, contact))

    expect(result.currency).toBe(currency)
  })
})
