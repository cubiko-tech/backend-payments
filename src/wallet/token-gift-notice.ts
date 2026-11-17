import { EntityManager } from 'typeorm'
import { TokenGiftNotice, TokenGiftNoticeStatus } from './entities/token-gift-notice.entity'

export interface TokenGiftNoticeEntry {
  brandId: string
  amount: number
  balanceAfter: number
  movementKey: string
  status?: TokenGiftNoticeStatus
}

/**
 * Writes a brand token gift notice (`token_gift_notices`) inside the movement's own transaction.
 * Carries only brand, signed amount, balanceAfter, movementKey, and status `pendiente` (never reason or author).
 */
export function recordTokenGiftNotice(
  manager: EntityManager,
  entry: TokenGiftNoticeEntry,
): Promise<TokenGiftNotice> {
  return manager.save(
    TokenGiftNotice,
    manager.create(TokenGiftNotice, {
      brandId: entry.brandId,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      movementKey: entry.movementKey,
      status: entry.status ?? TokenGiftNoticeStatus.PENDIENTE,
    }),
  )
}
