import { exchangeRateUnavailable } from '../trm/trm.service'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { renewalDeps } from '../../test/support/subscription-renewal.double'
import { retryFailedPayments } from './subscription-renewal'

/** A Confio subscription in arrears whose second retry is due: the cron issues another link. */
function dueRetry(): Subscription {
  return {
    id: 'sub-confio-retry',
    brandId: 'brand-1',
    userId: 'user-1',
    provider: SubscriptionProvider.CONFIO,
    planSlug: 'pro',
    status: SubscriptionStatus.PAST_DUE,
    autoRenew: true,
    retryCount: 1,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as Subscription
}

describe('retry of an external charge that fails', () => {
  afterEach(() => jest.restoreAllMocks())

  it('keeps retryCount when the checkout has no TRM to charge with', async () => {
    // Red if issueExternalCharge counts every error again: retryCount rises to 2.
    const sub = dueRetry()
    const { deps, processCheckout } = renewalDeps(sub)
    // The plan price does not quote the TRM today, so no real checkout gives this 503 yet.
    processCheckout.mockRejectedValueOnce(exchangeRateUnavailable())

    await retryFailedPayments(deps)

    expect(processCheckout).toHaveBeenCalledTimes(1)
    expect(sub.status).toBe(SubscriptionStatus.PAST_DUE)
    expect(sub.retryCount).toBe(1)
    expect(deps.subscriptionRepo.save).toHaveBeenCalledWith(sub)
  })

  it('still counts a retry that fails for any other reason', async () => {
    // Red if the TRM exemption swallows every error: retryCount stays at 1.
    const sub = dueRetry()
    const { deps, processCheckout } = renewalDeps(sub)
    processCheckout.mockRejectedValueOnce(new Error('provider down'))

    await retryFailedPayments(deps)

    expect(sub.status).toBe(SubscriptionStatus.PAST_DUE)
    expect(sub.retryCount).toBe(2)
  })
})
