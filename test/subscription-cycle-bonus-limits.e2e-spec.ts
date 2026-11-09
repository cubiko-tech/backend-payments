import { Logger } from '@nestjs/common'

import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import { WebhookStatus } from '../src/webhook/entities/webhookEvent.entity'
import { failNextWriteOf } from './support/audit-failure.fixture'
import {
  answerAsRoles,
  BonusChain,
  bonusesOf,
  catalog,
  cleanBonusBrand,
  deliver,
  eventsOf,
  ROLES_URL,
  seedConfioSubscription,
  settled,
  startBonusChain,
  tokenWalletOf,
  WEBHOOK_KEY,
} from './support/subscription-bonus.fixture'
import { RaceInstance, startInstance, stopInstance } from './support/wallet-race.fixture'

const BRAND = 'b2140214-3333-4333-8444-555555555214'

/** What stops a cycle bonus: its caps, a failed write and an unavailable plan catalog (LOC-214). */
describe('Subscription cycle bonus limits and failures (PostgreSQL, LOC-214)', () => {
  let a: RaceInstance
  let chain: BonusChain
  const originalEnv = process.env

  beforeAll(async () => {
    process.env = { ...originalEnv, CONFIO_WEBHOOK_KEY: WEBHOOK_KEY, SERVICE_ROLES: ROLES_URL }
    a = await startInstance()
    chain = await startBonusChain(a)
  })

  beforeEach(async () => {
    await cleanBonusBrand(a.dataSource, BRAND)
    process.env.SUBSCRIPTION_BONUS_MAX_TOKENS = '1000'
    process.env.SUBSCRIPTION_BONUS_MAX_TOKENS_PER_MONTH = '5000'
    catalog.plans = { 'pro-500': 500 }
    catalog.down = false
    chain.roles.invalidateCache()
    answerAsRoles()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      if (a) await cleanBonusBrand(a.dataSource, BRAND)
    } finally {
      await chain?.app.close()
      await stopInstance(a)
      process.env = originalEnv
    }
  })

  const ds = () => a.dataSource
  const subscription = (id: string) => ds().getRepository(Subscription).findOneByOrFail({ id })
  // R17: a spy that keeps logging; the cap cases read the line that names the brand.
  const warnings = () => jest.spyOn(Logger.prototype, 'warn')

  it('S6: a bonus over the per-credit cap credits nothing and logs the brand', async () => {
    // R15: red if the per-credit cap is not compared: 500 tokens are credited over a cap of 400.
    process.env.SUBSCRIPTION_BONUS_MAX_TOKENS = '400'
    const warn = warnings()
    const sub = await seedConfioSubscription(ds(), BRAND, 'pro-500')

    const notice = await deliver(chain, BRAND, 'SUCCEEDED')

    expect(notice.status).toBe(WebhookStatus.PROCESSED)
    expect(await bonusesOf(ds(), BRAND)).toHaveLength(0)
    expect(Number((await tokenWalletOf(ds(), BRAND)).balance)).toBe(0)
    expect(
      warn.mock.calls.some(([line]) => String(line).includes(`over the cap for brand ${BRAND}`)),
    ).toBe(true)
    // The charge itself is applied: the cap stops the bonus, not the renewal.
    expect((await subscription(sub.id)).status).toBe(SubscriptionStatus.ACTIVE)
    expect(await eventsOf(ds(), sub.id)).toHaveLength(1)
  })

  it('S7: a cycle that takes the brand over its monthly cap credits nothing and logs the brand', async () => {
    // R15: red if the monthly cap is not compared: the second cycle reaches 1000 over a cap of 800.
    process.env.SUBSCRIPTION_BONUS_MAX_TOKENS_PER_MONTH = '800'
    const warn = warnings()
    const sub = await seedConfioSubscription(ds(), BRAND, 'pro-500')

    await deliver(chain, BRAND, 'SUCCEEDED', 1, 'loc214-payment-1')
    const second = await deliver(chain, BRAND, 'SUCCEEDED', 2, 'loc214-payment-2')

    expect(second.status).toBe(WebhookStatus.PROCESSED)
    expect(await bonusesOf(ds(), BRAND)).toHaveLength(1)
    expect(Number((await tokenWalletOf(ds(), BRAND)).balance)).toBe(500)
    const line = `over the monthly cap for brand ${BRAND}`
    expect(warn.mock.calls.some(([text]) => String(text).includes(line))).toBe(true)
    expect(await eventsOf(ds(), sub.id)).toHaveLength(2)
  })

  it('S9: a write failing after the credit rolls all back and the retry credits once', async () => {
    // R15: red if the credit commits on its own: the failed delivery leaves tokens without effect.
    const sub = await seedConfioSubscription(ds(), BRAND, 'pro-500')
    const before = await subscription(sub.id)
    const failing = failNextWriteOf(SubscriptionEvent)

    const failed = await deliver(chain, BRAND, 'SUCCEEDED')

    expect(failed.status).toBe(WebhookStatus.FAILED)
    expect(await bonusesOf(ds(), BRAND)).toHaveLength(0)
    expect(Number((await tokenWalletOf(ds(), BRAND)).balance)).toBe(0)
    expect(
      await ds().getRepository(AuditLog).countBy({ userId: 'system:confio-subscription' }),
    ).toBe(0)
    expect(await eventsOf(ds(), sub.id)).toHaveLength(0)
    expect((await subscription(sub.id)).currentPeriodEnd).toEqual(before.currentPeriodEnd)

    failing.mockRestore()
    await chain.webhook.retryWebhook(failed.id)
    const retried = await settled(ds(), BRAND, 'loc214-payment-1')

    expect(retried.status).toBe(WebhookStatus.PROCESSED)
    expect(await bonusesOf(ds(), BRAND)).toHaveLength(1)
    expect(Number((await tokenWalletOf(ds(), BRAND)).balance)).toBe(500)
    expect(await eventsOf(ds(), sub.id)).toHaveLength(1)
  })

  it('S11: with backend-roles down and no catalog, the notice writes nothing and fails', async () => {
    // R15: red if an unavailable catalog reads as a plan without bonus: the notice is applied.
    catalog.down = true
    const sub = await seedConfioSubscription(ds(), BRAND, 'pro-500')
    const before = await subscription(sub.id)

    const notice = await deliver(chain, BRAND, 'SUCCEEDED')

    expect(notice.status).toBe(WebhookStatus.FAILED)
    expect(notice.error).toContain('Plan catalog unavailable')
    expect(await bonusesOf(ds(), BRAND)).toHaveLength(0)
    expect(await tokenWalletOf(ds(), BRAND)).toBeNull()
    expect(await eventsOf(ds(), sub.id)).toHaveLength(0)
    expect((await subscription(sub.id)).currentPeriodEnd).toEqual(before.currentPeriodEnd)
  })
})
