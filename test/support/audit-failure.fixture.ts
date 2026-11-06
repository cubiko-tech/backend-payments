import { EntityManager } from 'typeorm'

import { AuditLog } from '../../src/audit/entities/auditLog.entity'

/**
 * Fails the next `audit_log` write, wherever it comes from: `AuditService.record` inside a
 * transaction or `AuditService.log` through its repository, which delegates to the same `save`.
 */
export function failNextAuditWrite() {
  const save = EntityManager.prototype.save as (...args: unknown[]) => Promise<unknown>
  let failed = false
  // R17: a healthy PostgreSQL does not refuse one audit insert on demand.
  return jest.spyOn(EntityManager.prototype, 'save').mockImplementation(async function (
    this: EntityManager,
    ...args: unknown[]
  ) {
    if (args[0] === AuditLog && !failed) {
      failed = true
      throw new Error('audit write failed')
    }
    return save.apply(this, args)
  } as EntityManager['save'])
}
