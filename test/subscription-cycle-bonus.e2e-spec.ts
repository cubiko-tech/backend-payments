import { buildConfioWebhookEventId } from '../src/provider/confio/confio-webhook'
import { Subscription, SubscriptionStatus } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEventType } from '../src/subscription/entities/subscriptionEvent.entity'
import { WebhookEvent, WebhookStatus } from '../src/webhook/entities/webhookEvent.entity'
import {
  answerAsRoles,
  auditOf,
  BonusChain,
  bonusesOf,
  catalog,
  cleanBonusBrand,
  deliver,
  eventsOf,
  post,
  ROLES_URL,
  seedConfioSubscription,
  settled,
  signedCharge,
  startBonusChain,
  subName,
  tokenWalletOf,
  WEBHOOK_KEY,
} from './support/subscription-bonus.fixture'
import { RaceInstance, startInstance, stopInstance } from './support/wallet-race.fixture'

const BRAND_A = 'b2140214-1111-4333-8444-555555555214'
const BRAND_B = 'b2140214-2222-4333-8444-555555555214'

/** A paid Confio cycle credits its plan's bonus to the brand, once (LOC-214, CA2 of LOC-212). */
describe('Subscription cycle bonus (PostgreSQL, LOC-214)', () => {
  let a: RaceInstance
  let b: RaceInstance
  let chain: BonusChain
  let other: BonusChain
  const originalEnv = process.env

  beforeAll(async () => {
    process.env = { ...originalEnv, CONFIO_WEBHOOK_KEY: WEBHOOK_KEY, SERVICE_ROLES: ROLES_URL }
    a = await startInstance()
    b = await startInstance()
    chain = await startBonusChain(a)
    other = await startBonusChain(b)
  })

  beforeEach(async () => {
    for (const brand of [BRAND_A, BRAND_B]) await cleanBonusBrand(a.dataSource, brand)
    catalog.plans = { 'pro-500': 500, 'basic-0': 0 }
    catalog.down = false
    chain.roles.invalidateCache()
    other.roles.invalidateCache()
    answerAsRoles()
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    try {
      for (const brand of [BRAND_A, BRAND_B]) if (a) await cleanBonusBrand(a.dataSource, brand)
    } finally {
      await chain?.app.close()
      await other?.app.close()
      await stopInstance(a)
      await stopInstance(b)
      process.env = originalEnv
    }
  })

  const ds = () => a.dataSource

  it('S1: a paid cycle credits the plan bonus as gift to the brand of the subscription, audited', async () => {
    // R15: red if the wallet is taken from anything but the stored subscription's brand.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')

    const notice = await deliver(chain, BRAND_A, 'SUCCEEDED')

    expect(notice.status).toBe(WebhookStatus.PROCESSED)
    const wallet = await tokenWalletOf(ds(), BRAND_A)
    expect(Number(wallet.balance)).toBe(500)
    expect(Number(wallet.giftTokens)).toBe(500)
    const [bonus, ...more] = await bonusesOf(ds(), BRAND_A)
    expect(more).toHaveLength(0)
    expect(bonus).toMatchObject({
      walletId: wallet.id,
      tokenOrigin: 'gift',
      referenceId: sub.id,
      idempotencyKey: `subscription-bonus:${subName(BRAND_A)}:ciclo-1`,
    })
    const audit = await auditOf(ds(), wallet.id)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ userId: 'system:confio-subscription', action: 'token_gift' })
    expect(audit[0].changes).toMatchObject({ reason: 'subscription_cycle', amount: 500 })
    expect(audit[0].changes.transactionId).toBe(bonus.id)
    const events = await eventsOf(ds(), sub.id)
    expect(events.map((e) => e.eventType)).toEqual([SubscriptionEventType.PAYMENT_SUCCEEDED])
  })

  it('S2: the same notice twice, and its re-dispatch, credit once', async () => {
    // R15: red if both the effect marker and the cycle key stop guarding a re-dispatched notice.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')

    const notice = await deliver(chain, BRAND_A, 'SUCCEEDED')
    expect(await post(chain, signedCharge(BRAND_A, 'SUCCEEDED'))).toBe(200)
    await chain.webhook.retryWebhook(notice.id)
    const again = await settled(ds(), BRAND_A, 'loc214-payment-1')

    expect(again.status).toBe(WebhookStatus.PROCESSED)
    expect(await bonusesOf(ds(), BRAND_A)).toHaveLength(1)
    expect(Number((await tokenWalletOf(ds(), BRAND_A)).balance)).toBe(500)
    expect(await auditOf(ds(), (await tokenWalletOf(ds(), BRAND_A)).id)).toHaveLength(1)
    expect(await eventsOf(ds(), sub.id)).toHaveLength(1)
  })

  it('S3: another notice of the same cycle, with the plan bonus edited in between, credits once', async () => {
    // R15: red if the key stops coming from the cycle: the second attempt credits again.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    await deliver(chain, BRAND_A, 'SUCCEEDED', 1, 'loc214-payment-1')

    catalog.plans['pro-500'] = 700
    chain.roles.invalidateCache()
    const second = await deliver(chain, BRAND_A, 'SUCCEEDED', 1, 'loc214-payment-2')

    expect(second.status).toBe(WebhookStatus.PROCESSED)
    const bonuses = await bonusesOf(ds(), BRAND_A)
    expect(bonuses).toHaveLength(1)
    expect(Number(bonuses[0].amount)).toBe(500)
    expect(Number((await tokenWalletOf(ds(), BRAND_A)).balance)).toBe(500)
    // The charge's own effect is applied for both notices: only the bonus is once per cycle.
    expect(await eventsOf(ds(), sub.id)).toHaveLength(2)
  })

  it('S3b: the next cycle of the same subscription credits its own bonus', async () => {
    // R15: red if the cycle number leaves the key: the second cycle reads as already credited.
    await seedConfioSubscription(ds(), BRAND_A, 'pro-500')

    await deliver(chain, BRAND_A, 'SUCCEEDED', 1, 'loc214-payment-1')
    await deliver(chain, BRAND_A, 'SUCCEEDED', 2, 'loc214-payment-2')

    expect(await bonusesOf(ds(), BRAND_A)).toHaveLength(2)
    expect(Number((await tokenWalletOf(ds(), BRAND_A)).balance)).toBe(1000)
  })

  it('S4: the bonus is the plan tokensPerCycle: 500 credits 500, 0 credits nothing', async () => {
    // R15: red if the amount stops coming from the subscription's plan in the roles catalog.
    await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    const zero = await seedConfioSubscription(ds(), BRAND_B, 'basic-0')

    await deliver(chain, BRAND_A, 'SUCCEEDED')
    const notice = await deliver(chain, BRAND_B, 'SUCCEEDED')

    expect(Number((await tokenWalletOf(ds(), BRAND_A)).balance)).toBe(500)
    expect(notice.status).toBe(WebhookStatus.PROCESSED)
    expect(await bonusesOf(ds(), BRAND_B)).toHaveLength(0)
    expect(await tokenWalletOf(ds(), BRAND_B)).toBeNull()
    expect((await eventsOf(ds(), zero.id)).map((e) => e.eventType)).toEqual([
      SubscriptionEventType.PAYMENT_SUCCEEDED,
    ])
  })

  it('S5: a notice with another signature gets 401 and credits nothing', async () => {
    // R15: red if the bonus is planned before the signature check, or the route stops checking it.
    await seedConfioSubscription(ds(), BRAND_A, 'pro-500')

    const forged = signedCharge(BRAND_A, 'SUCCEEDED', 1, 'loc214-payment-1', 'another-key')

    expect(await post(chain, forged)).toBe(401)
    expect(await bonusesOf(ds(), BRAND_A)).toHaveLength(0)
    expect(await tokenWalletOf(ds(), BRAND_A)).toBeNull()
  })

  it('S8: a failed charge credits nothing', async () => {
    // R15: red if the bonus is planned for every billing notice instead of only PAYMENT_SUCCEEDED.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')

    const notice = await deliver(chain, BRAND_A, 'FAILED')

    expect(notice.status).toBe(WebhookStatus.PROCESSED)
    const row = await ds().getRepository(Subscription).findOneByOrFail({ id: sub.id })
    expect(row.status).toBe(SubscriptionStatus.PAST_DUE)
    expect(await bonusesOf(ds(), BRAND_A)).toHaveLength(0)
    expect(await tokenWalletOf(ds(), BRAND_A)).toBeNull()
  })

  it('S10: the same notice handled by two instances at once credits once', async () => {
    // R15: red if neither the effect marker nor the cycle key guard concurrent dispatches.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    const payload = signedCharge(BRAND_A, 'SUCCEEDED')
    const notice = { payload, providerEventId: buildConfioWebhookEventId(payload) } as WebhookEvent

    await Promise.all([chain.confio.handle(notice), other.confio.handle(notice)])

    expect(await bonusesOf(ds(), BRAND_A)).toHaveLength(1)
    expect(Number((await tokenWalletOf(ds(), BRAND_A)).balance)).toBe(500)
    expect(await eventsOf(ds(), sub.id)).toHaveLength(1)
  })

  it('S12: the active confirmation grants the plan without crediting a bonus', async () => {
    // R15: red if the active confirmation also plans the bonus: it is not a charge.
    const sub = await seedConfioSubscription(ds(), BRAND_A, 'pro-500')
    const repo = ds().getRepository(Subscription)
    await repo.update(sub.id, { status: SubscriptionStatus.PENDING })
    const pending = await repo.findOneByOrFail({ id: sub.id })

    const result = await chain.confio.confirmarContraElProveedor(pending)

    expect(result.resultado).toBe('otorgada')
    expect(await bonusesOf(ds(), BRAND_A)).toHaveLength(0)
    expect(await tokenWalletOf(ds(), BRAND_A)).toBeNull()
  })
})
