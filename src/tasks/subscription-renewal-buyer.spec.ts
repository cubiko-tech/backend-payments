import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import {
  buyerContactLookup,
  PAYER_CONTACT,
  PAYMENT_LINK,
  renewalDeps,
} from '../../test/support/subscription-renewal.double'
import { processSubscriptionRenewals, retryFailedPayments } from './subscription-renewal'

/** A one-shot Confio subscription whose period ended: the renewal cron issues a payment link. */
function dueConfioRenewal(): Subscription {
  return {
    id: 'sub-confio-renewal',
    brandId: 'brand-1',
    userId: 'user-1',
    provider: SubscriptionProvider.CONFIO,
    planSlug: 'pro',
    status: SubscriptionStatus.ACTIVE,
    autoRenew: true,
    nextBillingDate: new Date('2026-01-01T00:00:00Z'),
    retryCount: 0,
  } as Subscription
}

/** The same subscription in arrears with its second retry due. */
function dueConfioRetry(): Subscription {
  return {
    ...dueConfioRenewal(),
    status: SubscriptionStatus.PAST_DUE,
    retryCount: 1,
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  } as Subscription
}

const CONTACT_WITHOUT_PHONE = {
  email: PAYER_CONTACT.email,
  name: PAYER_CONTACT.name,
  callingCode: PAYER_CONTACT.callingCode,
}

describe('Confio renewal buyer', () => {
  it('sends the payer contact from auth in E.164 and issues the link', async () => {
    // Mutation: drop `...(buyer ? { buyer } : {})` from the processCheckout call in
    // subscription-renewal.ts -> the checkout gets no buyer and this case fails.
    const sub = dueConfioRenewal()
    const { deps, processCheckout, publishNotification, clientAuth } = renewalDeps(sub)

    await processSubscriptionRenewals(deps)

    expect(clientAuth.resolveBuyerContact).toHaveBeenCalledWith('user-1')
    expect(processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: SubscriptionProvider.CONFIO,
        renewal: true,
        buyer: expect.objectContaining({
          email: PAYER_CONTACT.email,
          phoneNumber: '+573001234567',
        }),
      }),
    )
    expect(publishNotification).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ checkoutUrl: PAYMENT_LINK }) }),
    )
  })

  it.each([
    ['the renewal', dueConfioRenewal, processSubscriptionRenewals, 0],
    ['the retry', dueConfioRetry, retryFailedPayments, 1],
  ])(
    'without a phone, %s asks nothing of Confio, says why and keeps retryCount',
    async (_label, build, run, retries) => {
      // Mutation (renewal row): drop `return holdWithoutBuyer(...)` -> processCheckout is called.
      // Mutation (retry row): `markLinkIssued(sub, true, deps)` in holdWithoutBuyer -> retryCount 2.
      const sub = build()
      const { deps, processCheckout } = renewalDeps(sub)
      ;(deps as { clientAuth: unknown }).clientAuth = buyerContactLookup(CONTACT_WITHOUT_PHONE)

      await run(deps)

      expect(processCheckout).not.toHaveBeenCalled()
      expect(sub.status).toBe(SubscriptionStatus.PAST_DUE)
      expect(sub.retryCount).toBe(retries)
      expect(deps.subscriptionRepo.update).toHaveBeenCalledWith(
        { id: sub.id },
        { status: SubscriptionStatus.PAST_DUE },
      )
      expect(deps.subscriptionEventRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          subscriptionId: sub.id,
          reason: expect.stringContaining('invalid_buyer buyer.phoneNumber'),
        }),
      )
    },
  )
})
