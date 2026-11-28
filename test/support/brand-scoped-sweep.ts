import { DataSource, EntityTarget, FindManyOptions, FindOptionsWhere, Repository } from 'typeorm'

import { Payment } from '../../src/payment/entities/payment.entity'
import { TasksService } from '../../src/tasks/tasks.service'
import { Transaction } from '../../src/transaction/entities/transaction.entity'

/**
 * Makes this instance's sweeps read only the payments of `brandId`. Specs share one database and
 * run at once, so an unscoped sweep closes another spec's payment without that spec's doubles.
 * Only `find` changes; every other call reaches the real repository, spies included.
 */
export function scopeSweepsToBrand(tasks: TasksService, brandId: string): void {
  const scoped = brandScoped(tasks.paymentRepo, brandId)
  ;(tasks as { paymentRepo: Repository<Payment> }).paymentRepo = scoped
}

/** `find` of `repo` with `brandId` added to every alternative of its `where`. */
function brandScoped<T extends { brandId: string }>(repo: Repository<T>, brandId: string) {
  const scoped: Repository<T> = Object.create(repo)
  scoped.find = (options: FindManyOptions<T> = {}) => {
    const where = [options.where ?? {}].flat() as FindOptionsWhere<T>[]
    return repo.find({ ...options, where: where.map((alt) => ({ ...alt, brandId })) })
  }
  return scoped
}

/**
 * Makes this instance's `refundOrphanRenewalDebits` read only the debits of `brandId`. That sweep
 * reads transactions through `tasks.dataSource`, out of reach of `scopeSweepsToBrand`, so the
 * data source is wrapped: its transaction repository scopes `find`, every other call is the real one.
 */
export function scopeRenewalRefundsToBrand(tasks: TasksService, brandId: string): void {
  const source = tasks.dataSource
  const transactions = brandScoped(source.getRepository(Transaction), brandId)
  const scoped: DataSource = Object.create(source)
  scoped.getRepository = <T>(target: EntityTarget<T>) =>
    (target === Transaction ? transactions : source.getRepository(target)) as Repository<T>
  ;(tasks as { dataSource: DataSource }).dataSource = scoped
}
