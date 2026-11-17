import { DataSource, QueryRunner, Repository } from 'typeorm'

import { lockBrandPlan } from '../checkout/wallet-payment-close'
import { logger } from '../shared/logger/logger'
import { Subscription } from '../subscription/entities/subscription.entity'

export interface SubscriptionLockDeps {
  subscriptionRepo: Repository<Subscription>
  dataSource: DataSource
  subscriptionLocks?: Map<string, Promise<void>>
}

/**
 * Takes the brand's plan lock and refreshes `sub` from the primary, returning what releases the
 * lock. Returns null, with the lock released, if either failed: nothing was charged, so that is
 * no failed payment and the next pass retries the row.
 */
export async function lockAndReread(
  sub: Subscription,
  deps: SubscriptionLockDeps,
): Promise<(() => Promise<void>) | null> {
  let release: (() => Promise<void>) | null = null
  try {
    release = await acquireSubscriptionLock(sub, deps)
    const fresh = await deps.subscriptionRepo.findOne?.({ where: { id: sub.id } })
    if (fresh) {
      Object.assign(sub, fresh)
    }
    return release
  } catch (error) {
    logger.log('error', `[CRON] Could not lock subscription ${sub.id}: ${error?.message}`)
    await release?.().catch(() => undefined)
    return null
  }
}

/**
 * Serializes work on `sub` across in-process passes and holds the brand's PostgreSQL advisory
 * plan lock inside a transaction until the returned releaser is called.
 */
export async function acquireSubscriptionLock(
  sub: Subscription,
  deps: SubscriptionLockDeps,
): Promise<() => Promise<void>> {
  const locks = deps.subscriptionLocks ?? (deps.subscriptionLocks = new Map())
  const subId = sub.id
  const previous = locks.get(subId) ?? Promise.resolve()
  let releaseLock!: () => void
  const current = new Promise<void>((resolve) => {
    releaseLock = resolve
  })
  const tail = previous.then(() => current)
  locks.set(subId, tail)

  let queryRunner: QueryRunner | null = null
  let released = false
  const release = async (commit = true) => {
    if (released) {
      return
    }
    released = true
    try {
      if (queryRunner) {
        try {
          if (queryRunner.isTransactionActive) {
            if (commit) {
              await queryRunner.commitTransaction()
            } else {
              await queryRunner.rollbackTransaction()
            }
          }
        } finally {
          if (!queryRunner.isReleased) {
            await queryRunner.release()
          }
        }
      }
    } finally {
      releaseLock()
      if (locks.get(subId) === tail) {
        locks.delete(subId)
      }
    }
  }

  try {
    await previous
    if (typeof (deps.dataSource as any)?.createQueryRunner === 'function') {
      const candidate = deps.dataSource.createQueryRunner()
      if (typeof candidate?.query === 'function') {
        queryRunner = candidate
        await queryRunner.connect()
        await queryRunner.startTransaction()
        await lockBrandPlan(queryRunner, sub.brandId)
      }
    }
    return () => release(true)
  } catch (error) {
    await release(false).catch(() => undefined)
    throw error
  }
}
