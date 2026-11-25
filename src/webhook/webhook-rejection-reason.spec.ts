import { WebhookController } from './webhook.controller'

/**
 * A compile-time case: ts-jest type-checks this file, so an unused `@ts-expect-error` fails it, and so
 * does `tsc --noEmit`. The runtime assertion only keeps jest from reporting an empty test.
 */
describe('Confio webhook rejection reason', () => {
  it('does not compile a caller that logs an invented reason', () => {
    // Mutation: type `reason` of `rechazarWebhookConfio` (webhook.controller.ts) as `string` again;
    // this `@ts-expect-error` becomes unused and the type-check of this file fails.
    const caller = (controller: WebhookController) =>
      // @ts-expect-error 'bearer_missmatch' is not a ConfioWebhookRejectionReason
      controller['rechazarWebhookConfio']('bearer_missmatch', '', '')

    expect(typeof caller).toBe('function')
  })
})
