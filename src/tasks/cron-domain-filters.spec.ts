import { SubscriptionProvider } from '../subscription/entities/subscription.entity'
import { WalletStatus } from '../wallet/entities/wallet.entity'
import { WebhookStatus } from '../webhook/entities/webhookEvent.entity'
import { TasksService } from './tasks.service'

// R17: repo doubles, because these cases check only the filter each cron sends, not the rows it gets.
const repo = () => ({
  find: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockResolvedValue({ affected: 0 }),
})

function buildService() {
  const walletReadRepo = repo()
  const subscriptionRepo = repo()
  const webhookEventRepo = repo()
  const snapshotRepo = repo()
  const transactionReadRepo = repo()
  const paymentRepo = repo()
  const subscriptionEventRepo = repo()
  const servicesUnusedByTheseCrons = Array.from({ length: 8 }, () => ({}))
  const args = [
    walletReadRepo,
    snapshotRepo,
    transactionReadRepo,
    paymentRepo,
    subscriptionRepo,
    subscriptionEventRepo,
    webhookEventRepo,
    ...servicesUnusedByTheseCrons,
  ]
  const service = new TasksService(
    ...(args as unknown as ConstructorParameters<typeof TasksService>),
  )
  return { service, walletReadRepo, subscriptionRepo, webhookEventRepo }
}

describe('TasksService — domain filters the crons send', () => {
  it('queries only Dropi subscriptions in processDropiBatchCharges', async () => {
    // R15: red if subscription-renewal.ts filters by another SubscriptionProvider (e.g. STRIPE).
    const { service, subscriptionRepo } = buildService()

    await service.processDropiBatchCharges()

    expect(subscriptionRepo.find).toHaveBeenCalledTimes(1)
    expect(subscriptionRepo.find.mock.calls[0][0].where.provider).toBe(SubscriptionProvider.DROPI)
  })

  it('deletes only processed webhooks in cleanupExpiredWebhooks', async () => {
    // R15: red if tasks.service.ts deletes another WebhookStatus (e.g. FAILED).
    const { service, webhookEventRepo } = buildService()

    await service.cleanupExpiredWebhooks()

    expect(webhookEventRepo.delete).toHaveBeenCalledTimes(1)
    expect(webhookEventRepo.delete.mock.calls[0][0].status).toBe(WebhookStatus.PROCESSED)
  })

  it('reconciles only active wallets in reconcileWalletBalances', async () => {
    // R15: red if payment-sweep.ts reads wallets of another WalletStatus (e.g. FROZEN).
    const { service, walletReadRepo } = buildService()

    await service.reconcileWalletBalances()

    expect(walletReadRepo.find).toHaveBeenCalledTimes(1)
    expect(walletReadRepo.find.mock.calls[0][0].where.status).toBe(WalletStatus.ACTIVE)
  })
})
