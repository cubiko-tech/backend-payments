import { Payment } from '../../src/payment/entities/payment.entity'
import { Subscription } from '../../src/subscription/entities/subscription.entity'

/**
 * DataSource double for unit specs that reach the wallet close through mocked repos.
 * R17: Locks and the rollback are not modeled; the wallet-checkout-close e2e proves them.
 */
export function walletCloseDataSource(repos: {
  payment: () => unknown
  subscription: () => unknown
  subscriptionEvent: () => unknown
}) {
  return {
    createQueryRunner: jest.fn(() => ({
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      manager: {
        query: jest.fn().mockResolvedValue([]),
        getRepository: (entity: unknown) => {
          if (entity === Payment) return repos.payment()
          return entity === Subscription ? repos.subscription() : repos.subscriptionEvent()
        },
      },
    })),
  }
}
