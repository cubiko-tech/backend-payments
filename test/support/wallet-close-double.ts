import { Payment } from '../../src/payment/entities/payment.entity'
import { Subscription } from '../../src/subscription/entities/subscription.entity'

/** Repositories a wallet close asks its transaction manager for. */
export interface WalletCloseRepos {
  paymentRepo: unknown
  subscriptionRepo: unknown
  subscriptionEventRepo: unknown
}

/** R17: Transaction manager double; its rollback is proven by the wallet-checkout-close e2e. */
export function walletCloseManager(repos: () => WalletCloseRepos) {
  return {
    query: jest.fn().mockResolvedValue([]),
    getRepository: (entity: unknown) => {
      if (entity === Payment) return repos().paymentRepo
      return entity === Subscription ? repos().subscriptionRepo : repos().subscriptionEventRepo
    },
  }
}

/** R17: DataSource double for unit specs that reach the wallet close through mocked repos. */
export function walletCloseDataSource(repos: () => WalletCloseRepos) {
  return {
    query: jest.fn().mockResolvedValue([]),
    transaction: jest.fn((work: (manager: unknown) => unknown) => work(walletCloseManager(repos))),
    createQueryRunner: jest.fn(() => ({
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
      manager: walletCloseManager(repos),
    })),
  }
}
