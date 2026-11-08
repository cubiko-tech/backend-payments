import { QueryRunner } from 'typeorm'

/** Caps on how long a movement waits for the wallet row and on each of its statements, in ms. */
export interface MovementLimits {
  lockTimeoutMs: number
  statementTimeoutMs: number
}

/** Sets `limits` for the rest of the open transaction of `queryRunner` only. */
export async function applyLimits(queryRunner: QueryRunner, limits: MovementLimits) {
  // SET takes no bind parameters; the values are integers built here, never caller text.
  const lock = Math.trunc(limits.lockTimeoutMs)
  const statement = Math.trunc(limits.statementTimeoutMs)
  await queryRunner.query(`SET LOCAL lock_timeout = ${lock}`)
  await queryRunner.query(`SET LOCAL statement_timeout = ${statement}`)
}

/** True for 55P03 lock_not_available (lock_timeout) and 57014 query_canceled (statement_timeout). */
export function isLimitHit(error: any): boolean {
  const code = error?.code ?? error?.driverError?.code
  return code === '55P03' || code === '57014'
}
