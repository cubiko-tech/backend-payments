import { EntityManager } from 'typeorm'
import { Transaction } from './entities/transaction.entity'

/**
 * Writes the audit of a movement inside the movement's own transaction, after it is saved and before
 * it commits. Throwing rolls the movement back. Never called for a replayed movement.
 */
export type MovementAudit = (manager: EntityManager, transaction: Transaction) => Promise<unknown>
