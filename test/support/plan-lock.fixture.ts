import { DataSource, Repository } from 'typeorm'

import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../../src/subscription/entities/subscription.entity'
import { Gate, RaceInstance, someoneWaitsOnAdvisoryLock } from './wallet-race.fixture'

export const DAY_MS = 24 * 60 * 60 * 1000

/** A subscription of `planSlug` whose billing date passed one hour ago, unless told otherwise. */
export async function seedSubscription(
  dataSource: DataSource,
  brandId: string,
  overrides: Partial<Subscription> = {},
): Promise<Subscription> {
  const repo = dataSource.getRepository(Subscription)
  const due = new Date(Date.now() - 60 * 60 * 1000)
  return repo.save(
    repo.create({
      brandId,
      userId: 'user-loc88',
      planSlug: 'dropi-roax',
      status: SubscriptionStatus.ACTIVE,
      provider: SubscriptionProvider.WALLET,
      currentPeriodStart: new Date(due.getTime() - 30 * DAY_MS),
      currentPeriodEnd: due,
      nextBillingDate: due,
      autoRenew: true,
      ...overrides,
    }),
  )
}

/** Makes the retry backoff of a past-due row elapse, past what any retry count asks for. */
export function elapseRetryBackoff(dataSource: DataSource, subscriptionId: string) {
  return dataSource.query(
    `UPDATE subscriptions SET "updatedAt" = NOW() - INTERVAL '10 days' WHERE id = $1`,
    [subscriptionId],
  )
}

/** Makes the next cron pass of `instance` see only these brands' rows. */
export function sweepOnlyBrands(instance: RaceInstance, brandIds: string[]) {
  const repo = (instance.tasks as any).subscriptionRepo
  const find = repo.find.bind(repo)
  // R17: The crons read all brands, and a spec in another worker must not have its rows charged.
  return jest.spyOn(repo, 'find').mockImplementationOnce(async (options: unknown) => {
    const rows: Subscription[] = await find(options)
    return rows.filter((row) => brandIds.includes(row.brandId))
  })
}

/** Parks the first subscription save of any instance: after reading the row, before writing it. */
export function parkFirstSubscriptionSave(gate: Gate) {
  const save = Repository.prototype.save
  let parked = false
  // R17: The race lives between reading and saving, and only a held call can land in it on demand.
  return jest.spyOn(Repository.prototype, 'save').mockImplementation(async function (
    this: Repository<any>,
    ...args: any[]
  ) {
    if (!parked && this.target === Subscription) {
      parked = true
      gate.arrive()
      await gate.wait
    }
    return (save as any).apply(this, args)
  } as any)
}

/** Parks the first subscription update of any instance: after reading the row, before writing it. */
export function parkFirstSubscriptionUpdate(gate: Gate) {
  const update = Repository.prototype.update
  let parked = false
  // R17: The race lives between reading and updating, and only a held call can land in it on demand.
  return jest.spyOn(Repository.prototype, 'update').mockImplementation(async function (
    this: Repository<any>,
    ...args: any[]
  ) {
    if (!parked && this.target === Subscription) {
      parked = true
      gate.arrive()
      await gate.wait
    }
    return (update as any).apply(this, args)
  } as any)
}

/** Resolves once `rival` either blocks on a lock or ends, so the parked work can go on. */
export function rivalWaitsOrEnds(rival: Promise<unknown>, dataSource: DataSource) {
  return Promise.race([rival.catch(() => undefined), someoneWaitsOnAdvisoryLock(dataSource)])
}

/** Fails taking the plan lock of `brandId` on every runner of `instance`. */
export function failPlanLockOf(instance: RaceInstance, brandId: string) {
  const createQueryRunner = instance.dataSource.createQueryRunner.bind(instance.dataSource)
  // R17: A connection dropping exactly at this statement cannot be provoked on demand.
  return jest.spyOn(instance.dataSource, 'createQueryRunner').mockImplementation((...args) => {
    const runner = createQueryRunner(...args)
    const query = runner.query.bind(runner)
    runner.query = (async (sql: string, params?: unknown[], ...rest: [any]) => {
      if (sql.includes('pg_advisory') && String(params?.[0]).includes(brandId)) {
        throw new Error('Connection lost taking the lock')
      }
      return query(sql, params, ...rest)
    }) as typeof runner.query
    return runner
  })
}

export function daysLeft(subscription: Subscription) {
  return Math.round((new Date(subscription.currentPeriodEnd).getTime() - Date.now()) / DAY_MS)
}
