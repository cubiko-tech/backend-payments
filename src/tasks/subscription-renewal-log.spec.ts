import { logger } from '../shared/logger/logger'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { PAYMENT_LINK, renewalDeps } from '../../test/support/subscription-renewal.double'
import { processTrialConversions } from './subscription-renewal'

/** An expired Confio trial with no initial link yet: the cron issues the external charge. */
function expiredConfioTrial(): Subscription {
  return {
    id: 'sub-confio-1',
    brandId: 'brand-1',
    userId: 'user-1',
    provider: SubscriptionProvider.CONFIO,
    planSlug: 'pro',
    status: SubscriptionStatus.TRIAL,
    autoRenew: true,
    nextBillingDate: new Date('2026-01-01T00:00:00Z'),
    retryCount: 0,
  } as Subscription
}

describe('external charge log line', () => {
  afterEach(() => jest.restoreAllMocks())

  it('logs the paymentId of the link and never the URL, while the notification keeps the URL', async () => {
    // Red if the line logs `result.checkoutUrl` again: the URL shows up in the captured log.
    const logSpy = jest.spyOn(logger, 'log')
    const { deps, publishNotification } = renewalDeps(expiredConfioTrial())

    await processTrialConversions(deps)

    const lines = logSpy.mock.calls.map((call) => String(call[1]))
    const linkLine = lines.find((line) => line.includes('[CRON] Link de cobro'))
    expect(linkLine).toContain('paymentId=pay-1')
    expect(lines.join('\n')).not.toContain(PAYMENT_LINK)
    expect(publishNotification).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ checkoutUrl: PAYMENT_LINK }) }),
    )
  })
})
