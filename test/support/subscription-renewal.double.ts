import { Subscription } from '../../src/subscription/entities/subscription.entity'
import { SubscriptionRenewalDeps } from '../../src/tasks/subscription-renewal'

export const PAYMENT_LINK = 'https://pay.example/abc'

/** What backend-auth keeps of the payer: a local phone plus its calling code, as the signup gets it. */
export const PAYER_CONTACT = {
  email: 'ana.gomez@example.com',
  name: 'Ana Gomez',
  phone: '3001234567',
  callingCode: '57',
}

/**
 * Double (R17) for `ClientAuthService.resolveBuyerContact`: auth is another service, and these
 * cases only need the contact it answers. Defaults to `PAYER_CONTACT`.
 */
export function buyerContactLookup(contact: Record<string, string> = PAYER_CONTACT) {
  return { resolveBuyerContact: jest.fn().mockResolvedValue({ ok: true, contact }) }
}

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
  const clientAuth = buyerContactLookup()
  const deps = {
    subscriptionRepo: {
      find: jest.fn().mockResolvedValue([sub]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (row: unknown) => row),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    },
    subscriptionEventRepo: {
      create: jest.fn().mockImplementation((row: unknown) => row),
      save: jest.fn().mockImplementation(async (row: unknown) => row),
    },
    eventBus: { publishNotification },
    checkoutService: { processCheckout },
    clientAuth,
    dataSource: {},
    MAX_RETRY: 3,
  }

  return {
    deps: deps as unknown as SubscriptionRenewalDeps,
    publishNotification,
    processCheckout,
    clientAuth,
  }
}
