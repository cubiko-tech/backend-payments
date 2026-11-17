import { Subscription } from '../../src/subscription/entities/subscription.entity'
import { SubscriptionRenewalDeps } from '../../src/tasks/subscription-renewal'

export const PAYMENT_LINK = 'https://pay.example/abc'

/**
 * Doubles (R17) for the external-charge path of the renewal cron: the repositories and the event
 * bus are in-memory stand-ins, since these cases read what the cron decided on `sub`, not what the
 * database kept; `processCheckout` is the fake checkout that returns the payment link.
 * `dataSource` has no `createQueryRunner`, so the plan lock stays in-process.
 */
export function renewalDeps(sub: Subscription) {
  const publishNotification = jest.fn().mockResolvedValue(undefined)
  const processCheckout = jest
    .fn()
    .mockResolvedValue({ paymentId: 'pay-1', status: 'pending', checkoutUrl: PAYMENT_LINK })
  const deps = {
    subscriptionRepo: {
      find: jest.fn().mockResolvedValue([sub]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (row: unknown) => row),
    },
    subscriptionEventRepo: {
      create: jest.fn().mockImplementation((row: unknown) => row),
      save: jest.fn().mockImplementation(async (row: unknown) => row),
    },
    eventBus: { publishNotification },
    checkoutService: { processCheckout },
    dataSource: {},
    MAX_RETRY: 3,
  }

  return { deps: deps as unknown as SubscriptionRenewalDeps, publishNotification, processCheckout }
}
