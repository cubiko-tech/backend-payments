import { DeepPartial, FindOptionsWhere, Repository } from 'typeorm'
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity'

import { ApmAgent } from '../shared/apm/apm-agent'
import { logger } from '../shared/logger/logger'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import {
  acquireSubscriptionLock,
  SubscriptionLockDeps,
  SubscriptionLockRelease,
} from './subscription-lock'

/**
 * How a subscription cron closes a row: under the row's lock, re-read, with the compare-and-set
 * and its event in one transaction, one row at a time, telling New Relic what roles refused.
 */
export interface SubscriptionCloseDeps extends SubscriptionLockDeps {
  subscriptionEventRepo: Repository<SubscriptionEvent>
  apm?: ApmAgent
}

/** New Relic event of one cron pass whose downgrades `backend-roles` refused, with their count. */
export const SUBSCRIPTION_DOWNGRADE_REFUSED_EVENT = 'SubscriptionDowngradeRefused'

export type CloseOutcome = 'closed' | 'rejected' | 'skipped'

/**
 * Runs `work` on `sub` under its lock, re-read from the primary. A throw rolls back what `work`
 * wrote through the lock, so the row stays as it was for the next pass.
 */
export async function underRowLock<T>(
  sub: Subscription,
  deps: SubscriptionCloseDeps,
  work: (release: SubscriptionLockRelease) => Promise<T>,
): Promise<T> {
  const release = await acquireSubscriptionLock(sub, deps)
  try {
    const fresh = await deps.subscriptionRepo.findOne?.({ where: { id: sub.id } })
    if (fresh) {
      Object.assign(sub, fresh)
    }
    return await work(release)
  } catch (error) {
    await release.abort()
    throw error
  } finally {
    await release()
  }
}

/**
 * Writes the compare-and-set and its event in the lock's transaction, so both land or neither.
 * Returns false, writing nothing, when the row is no longer in the state `criteria` expects.
 */
export async function closeRow(
  release: SubscriptionLockRelease,
  deps: SubscriptionCloseDeps,
  criteria: FindOptionsWhere<Subscription>,
  changes: QueryDeepPartialEntity<Subscription>,
  event: DeepPartial<SubscriptionEvent>,
): Promise<boolean> {
  const subscriptions = release.manager?.getRepository(Subscription) ?? deps.subscriptionRepo
  const events = release.manager?.getRepository(SubscriptionEvent) ?? deps.subscriptionEventRepo
  const closed = await subscriptions.update(criteria, changes)
  if (!closed.affected) return false
  await events.save(events.create(event))
  return true
}

/** Runs `close` on each row; a row that throws stays for the next pass and the batch goes on. */
export async function closeEach(
  cron: string,
  rows: Subscription[],
  close: (sub: Subscription) => Promise<CloseOutcome>,
  deps: SubscriptionCloseDeps,
): Promise<{ closed: number; rejected: number }> {
  let closed = 0
  let rejected = 0
  for (const sub of rows) {
    try {
      const outcome = await close(sub)
      if (outcome === 'closed') closed++
      if (outcome === 'rejected') rejected++
    } catch (error) {
      logger.log(
        'error',
        `[CRON] ${cron}: ${sub.id} not closed, left for the next pass: ${error?.message}`,
      )
    }
  }
  if (rejected > 0) recordRefusedDowngrades(cron, rejected, deps)
  return { closed, rejected }
}

/** Tells New Relic how many rows of a pass `backend-roles` refused to downgrade. */
export function recordRefusedDowngrades(
  cron: string,
  count: number,
  deps: Pick<SubscriptionCloseDeps, 'apm'>,
): void {
  try {
    deps.apm?.recordCustomEvent(SUBSCRIPTION_DOWNGRADE_REFUSED_EVENT, { cron, count })
  } catch (error) {
    logger.log(
      'warn',
      `[CRON] ${SUBSCRIPTION_DOWNGRADE_REFUSED_EVENT} not recorded: ${error?.message}`,
    )
  }
}
