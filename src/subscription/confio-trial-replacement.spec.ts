import { HttpStatus } from '@nestjs/common'

import { ClientAuthService } from '../client/client-auth.service'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { ConfioPlanService } from '../provider/confio/confio-plan.service'
import { ConfioProvider } from '../provider/confio/confio.provider'
import { RequestException } from '../shared/exception/request.exception'
import { ConfioCancellationService } from './confio-cancellation.service'
import { ConfioTrialService } from './confio-trial.service'

const PREVIOUS = 'stores/s/subscription-plans/p/subscriptions/old'

/**
 * Doubles (R17): platform, roles and the plan map answer the happy path, auth answers a user
 * without a phone, and ConfioPagos (signup and cancel) records whether it was called.
 */
function signupWithoutPhone() {
  const ok = <T>(value: T) => jest.fn().mockResolvedValue(value)
  const contact = { email: 'ana.gomez@example.com', name: 'Ana Gomez', callingCode: '57' }
  const cancellation = { cancel: ok(undefined) }
  const confio = { createSubscription: jest.fn() }
  const service = new ConfioTrialService(
    { resolveBrandCountry: ok({ ok: true, country: 'CO' }) } as unknown as ClientPlatformService,
    {
      resolvePriceForCountry: ok({ ok: true, price: { currency: 'COP', price: 19900 } }),
    } as unknown as ClientRolesService,
    { resolveBuyerContact: ok({ ok: true, contact }) } as unknown as ClientAuthService,
    { resolveConfioPlanName: ok('stores/s/subscription-plans/p') } as unknown as ConfioPlanService,
    confio as unknown as ConfioProvider,
    cancellation as unknown as ConfioCancellationService,
  )
  return { service, cancellation, confio }
}

describe('Confio signup that replaces a previous subscription', () => {
  it('rejects an invalid buyer with 422 INVALID_BUYER and keeps the previous one', async () => {
    // Mutation: build the buyer after `confioCancellation.cancel` in confio-trial.service.ts
    // -> the previous subscription is cancelled and this case fails.
    const { service, cancellation, confio } = signupWithoutPhone()

    const error = await service
      .createForTrial({
        brandId: 'brand-1',
        userId: 'user-1',
        planSlug: 'dropi-roax',
        conPrueba: true,
        reemplazaA: PREVIOUS,
      })
      .catch((e) => e)

    expect(error).toBeInstanceOf(RequestException)
    expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY)
    expect(error.code).toBe('INVALID_BUYER')
    expect(cancellation.cancel).not.toHaveBeenCalled()
    expect(confio.createSubscription).not.toHaveBeenCalled()
  })
})
