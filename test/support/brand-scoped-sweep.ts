import { FindManyOptions, FindOptionsWhere, Repository } from 'typeorm'

import { Payment } from '../../src/payment/entities/payment.entity'
import { TasksService } from '../../src/tasks/tasks.service'

/**
 * Makes this instance's sweeps read only the payments of `brandId`. Specs share one database and
 * run at once, so an unscoped sweep closes another spec's payment without that spec's doubles.
 * Only `find` changes; every other call reaches the real repository, spies included.
 */
export function scopeSweepsToBrand(tasks: TasksService, brandId: string): void {
  const payments = tasks.paymentRepo
  const scoped: Repository<Payment> = Object.create(payments)
  scoped.find = (options: FindManyOptions<Payment> = {}) => {
    const where = [options.where ?? {}].flat() as FindOptionsWhere<Payment>[]
    return payments.find({ ...options, where: where.map((alt) => ({ ...alt, brandId })) })
  }
  ;(tasks as { paymentRepo: Repository<Payment> }).paymentRepo = scoped
}
