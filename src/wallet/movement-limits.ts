import { HttpStatus } from '@nestjs/common'
import { QueryRunner } from 'typeorm'

import { RequestException } from '../shared/exception/request.exception'

/** A movement that ran out of its limits: nothing was applied; retry with the same key. */
export const walletBusy = () =>
  new RequestException(
    { code: 'WALLET_BUSY', message: 'Wallet is busy, retry with the same key' },
    HttpStatus.SERVICE_UNAVAILABLE,
  )

/**
 * Caps of a movement, in ms: how long it waits for a pool connection, and how long its whole
 * transaction may last, lock waits and COMMIT included.
 */
export interface MovementLimits {
  connectTimeoutMs: number
  transactionTimeoutMs: number
}

/** A wait given up on: nothing was written, so retrying with the same key is safe. */
export class LimitExceeded extends Error {
  constructor(ms: number) {
    super(`Gave up after ${ms} ms`)
    this.name = 'LimitExceeded'
  }
}

/**
 * `work`, or a `LimitExceeded` after `ms`. It stops waiting, not the work: use it only for work
 * that writes nothing, or that releases what it holds when it ends.
 */
export async function withinMs<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LimitExceeded(ms)), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Connects `queryRunner` within `ms`; a connection that arrives later goes back to the pool. */
export async function connectWithin(queryRunner: QueryRunner, ms: number): Promise<void> {
  const connecting = queryRunner.connect()
  try {
    await withinMs(connecting, ms)
  } catch (error) {
    connecting.then(
      () => queryRunner.release(),
      () => undefined,
    )
    throw error
  }
}

/**
 * Caps the open transaction of `queryRunner` as a whole. PostgreSQL ends the session when it
 * passes, so the transaction rolls back on the server even if this process is not waiting.
 */
export async function applyLimits(queryRunner: QueryRunner, limits: MovementLimits) {
  // SET takes no bind parameters; the value is an integer built here, never caller text.
  await queryRunner.query(
    `SET LOCAL transaction_timeout = ${Math.trunc(limits.transactionTimeoutMs)}`,
  )
}

/**
 * True for a wait given up on here, and for 25P04 transaction_timeout, 55P03 lock_not_available
 * and 57014 query_canceled from PostgreSQL.
 */
export function isLimitHit(error: any): boolean {
  if (error instanceof LimitExceeded) return true
  const code = error?.code ?? error?.driverError?.code
  return code === '25P04' || code === '55P03' || code === '57014'
}
