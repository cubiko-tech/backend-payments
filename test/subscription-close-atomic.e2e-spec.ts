import { Repository } from 'typeorm'

import { ClientRolesService } from '../src/client/client-roles.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import { ConfioPlanPriceCheckService } from '../src/provider/confio/confio-plan-price-check.service'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../src/subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../src/subscription/entities/subscriptionEvent.entity'
import { SUBSCRIPTION_DOWNGRADE_REFUSED_EVENT } from '../src/tasks/subscription-close'
import { DAY_MS, rivalWaitsOrEnds, seedSubscription } from './support/plan-lock.fixture'
import {
  cleanBrand,
  createGate,
  RaceInstance,
  seedWallet,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const BRANDS = [
  'b7274001-2222-4333-8444-555555555551',
  'b7274001-2222-4333-8444-555555555552',
  'b7274001-2222-4333-8444-555555555553',
]
const [BRAND_ID] = BRANDS

/** The subscription crons close each row at once, one replica at a time (PostgreSQL, LOC-274). */
describe('Subscription crons close each row at once', () => {
  let a: RaceInstance
  let b: RaceInstance
  let removePlan: jest.Mock

  const stubRemotes = (instance: RaceInstance) => {
    // R17: roles is another service; each case decides how it answers the downgrade.
    Object.assign(instance.moduleRef.get(ClientRolesService), { removePlanFromBrand: removePlan })
    // R17: Redis is remote, and no case here decides on what it publishes.
    Object.assign(instance.moduleRef.get(EventBusService), {
      publishSubscriptionExpired: jest.fn(),
      notifySubscriptionExpired: jest.fn().mockResolvedValue(null),
      publishNotification: jest.fn(),
    })
    const repo = instance.dataSource.getRepository(Subscription)
    const find = repo.find.bind(repo)
    // R17: the crons read all brands, and a spec in another worker must not have its rows closed.
    jest
      .spyOn((instance.tasks as any).subscriptionRepo, 'find')
      .mockImplementation((async (options: unknown) =>
        (await find(options as any)).filter((row) => BRANDS.includes(row.brandId))) as any)
  }

  const cleanAll = async () => {
    for (const brandId of BRANDS) await cleanBrand(a.dataSource, brandId)
  }

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
  })

  beforeEach(async () => {
    await cleanAll()
    // R17: roles is another service; it accepts the downgrade unless a case says otherwise.
    removePlan = jest.fn().mockResolvedValue(true)
    stubRemotes(a)
    stubRemotes(b)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanAll()
    await stopInstance(a)
    await stopInstance(b)
  })

  const subscriptionOf = async (brandId: string) =>
    (await a.dataSource.getRepository(Subscription).findOneBy({ brandId }))!

  const eventsOf = async (brandId: string, eventType: SubscriptionEventType) =>
    a.dataSource
      .getRepository(SubscriptionEvent)
      .countBy({ subscriptionId: (await subscriptionOf(brandId)).id, eventType })

  /** A deferred cancellation whose paid access ended `hoursAgo` hours ago. */
  const seedDueCancellation = (brandId: string, hoursAgo = 1) =>
    seedSubscription(a.dataSource, brandId, {
      autoRenew: false,
      cancelledAt: new Date(),
      accessEndsAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
    })

  /** Makes the next writes of `entity` throw for the rows `matches` picks, `times` times. */
  const failWrites = (
    method: 'save' | 'update',
    entity: unknown,
    matches: (args: any[]) => boolean,
    times = 1,
  ) => {
    const original = (Repository.prototype as any)[method]
    let left = times
    // R17: a database failure exactly at this statement cannot be provoked on demand.
    return jest.spyOn(Repository.prototype, method as any).mockImplementation(async function (
      this: Repository<any>,
      ...args: any[]
    ) {
      if (this.target === entity && matches(args) && left-- > 0) throw new Error('connection lost')
      return original.apply(this, args)
    } as any)
  }

  it('C1: a failure between the two writes leaves the row as it was, closed on the next pass', async () => {
    // Mutation: closeRow writes through deps.subscriptionRepo and deps.subscriptionEventRepo instead of
    // release.manager: the row stays cancelled without its event and this case goes red.
    await seedDueCancellation(BRAND_ID)
    failWrites('save', SubscriptionEvent, () => true)

    await a.tasks.expireCancelledSubscriptions()

    expect((await subscriptionOf(BRAND_ID)).status).toBe(SubscriptionStatus.ACTIVE)
    expect(await eventsOf(BRAND_ID, SubscriptionEventType.EXPIRED)).toBe(0)

    jest.mocked(Repository.prototype.save).mockRestore()
    await a.tasks.expireCancelledSubscriptions()

    expect((await subscriptionOf(BRAND_ID)).status).toBe(SubscriptionStatus.CANCELLED)
    expect(await eventsOf(BRAND_ID, SubscriptionEventType.EXPIRED)).toBe(1)
  })

  it('C2: a row that fails stays for the next pass and the batch goes on', async () => {
    // Mutation: closeEach loses its per-row try/catch: the second row's throw ends the pass and the
    // third stays open, so this case goes red.
    for (const [index, brandId] of BRANDS.entries()) await seedDueCancellation(brandId, 3 - index)
    const second = (await subscriptionOf(BRANDS[1])).id
    failWrites('update', Subscription, ([criteria]) => criteria?.id === second)

    await a.tasks.expireCancelledSubscriptions()

    for (const brandId of [BRANDS[0], BRANDS[2]]) {
      expect((await subscriptionOf(brandId)).status).toBe(SubscriptionStatus.CANCELLED)
      expect(await eventsOf(brandId, SubscriptionEventType.EXPIRED)).toBe(1)
    }
    expect((await subscriptionOf(BRANDS[1])).status).toBe(SubscriptionStatus.ACTIVE)
    expect(await eventsOf(BRANDS[1], SubscriptionEventType.EXPIRED)).toBe(0)
  })

  it('C3: the same cron on two replicas closes the row once', async () => {
    // Mutation: underRowLock skips acquireSubscriptionLock: the second replica downgrades in roles
    // while the first is still there, and this case goes red.
    await seedDueCancellation(BRAND_ID)
    const inRoles = createGate()
    removePlan.mockImplementationOnce(async () => {
      inRoles.arrive()
      await inRoles.wait
      return true
    })

    const first = a.tasks.expireCancelledSubscriptions()
    await inRoles.reached
    const second = b.tasks.expireCancelledSubscriptions()
    await rivalWaitsOrEnds(second, a.dataSource)
    inRoles.release()
    await Promise.all([first, second])

    expect((await subscriptionOf(BRAND_ID)).status).toBe(SubscriptionStatus.CANCELLED)
    expect(await eventsOf(BRAND_ID, SubscriptionEventType.EXPIRED)).toBe(1)
    expect(removePlan).toHaveBeenCalledTimes(1)
  })

  it('C4: a Confio trial whose signup issued its link leaves the conversions and ends on free', async () => {
    // Mutation: expireSubscriptions no longer calls endMarkedTrialsWithoutCharge: the trial stays
    // skipped with no end and this case goes red.
    const billed = new Date(Date.now() - 2 * DAY_MS)
    await seedSubscription(a.dataSource, BRAND_ID, {
      status: SubscriptionStatus.TRIAL,
      provider: SubscriptionProvider.CONFIO,
      initialPaymentLinkIssuedAt: new Date(billed.getTime() - 14 * DAY_MS),
      nextBillingDate: billed,
    })
    const find = jest.mocked((a.tasks as any).subscriptionRepo.find)

    await a.tasks.processTrialConversions()

    const batch: Subscription[] = await find.mock.results[0].value
    expect(batch.map((row) => row.brandId)).not.toContain(BRAND_ID)

    await a.tasks.expireSubscriptions()

    const sub = await subscriptionOf(BRAND_ID)
    expect(sub.status).toBe(SubscriptionStatus.EXPIRED)
    expect(sub.autoRenew).toBe(false)
    expect(await eventsOf(BRAND_ID, SubscriptionEventType.TRIAL_ENDED)).toBe(1)
    expect(removePlan).toHaveBeenCalledWith(BRAND_ID, sub.planSlug)
    expect(a.assignPlan).toHaveBeenCalledWith(BRAND_ID, 'free')
  })

  it('C4b: a wallet trial with the signup mark still charges its wallet', async () => {
    // Mutation: the initialPaymentLinkIssuedAt guard moves above the wallet branch of
    // processTrialConversions: the funded wallet trial is skipped and this case goes red.
    const wallet = await seedWallet(a.dataSource, BRAND_ID)
    await seedSubscription(a.dataSource, BRAND_ID, {
      status: SubscriptionStatus.TRIAL,
      walletId: wallet.id,
      initialPaymentLinkIssuedAt: new Date(Date.now() - 14 * DAY_MS),
    })

    await a.tasks.processTrialConversions()

    expect((await subscriptionOf(BRAND_ID)).status).toBe(SubscriptionStatus.ACTIVE)
  })

  it('C5: a downgrade roles refuses records the APM event with the count', async () => {
    // Mutation: closeEach drops its recordRefusedDowngrades call: no event reaches the agent and this
    // case goes red.
    for (const brandId of BRANDS.slice(0, 2)) await seedDueCancellation(brandId)
    removePlan.mockResolvedValue(false)
    const recordCustomEvent = jest.fn()
    Object.assign(a.tasks, { apm: { recordCustomEvent } })

    await a.tasks.expireCancelledSubscriptions()

    expect(recordCustomEvent).toHaveBeenCalledTimes(1)
    expect(recordCustomEvent).toHaveBeenCalledWith(SUBSCRIPTION_DOWNGRADE_REFUSED_EVENT, {
      cron: 'expireCancelledSubscriptions',
      count: 2,
    })
    expect((await subscriptionOf(BRANDS[0])).status).toBe(SubscriptionStatus.ACTIVE)
  })

  it('C6: the daily price check runs once with two replicas', async () => {
    // Mutation: takeRun returns taken: true without pg_try_advisory_xact_lock: the second replica
    // reads the mappings too and this case goes red.
    const reading = createGate()
    const first = { findAllMappings: jest.fn() }
    first.findAllMappings.mockImplementation(async () => {
      reading.arrive()
      await reading.wait
      return []
    })
    const second = { findAllMappings: jest.fn().mockResolvedValue([]) }
    // R17: the catalog is backend-roles; no mapping reaches it in this case.
    const roles = { getPlanPriceCents: jest.fn() }
    const check = (planes: unknown, instance: RaceInstance) =>
      new ConfioPlanPriceCheckService(planes as any, roles as any, instance.dataSource)

    const running = check(first, a).verificarPreciosContraElCatalogo()
    await reading.reached
    await check(second, b).verificarPreciosContraElCatalogo()
    reading.release()
    await running

    expect(first.findAllMappings).toHaveBeenCalledTimes(1)
    expect(second.findAllMappings).not.toHaveBeenCalled()
  })
})
