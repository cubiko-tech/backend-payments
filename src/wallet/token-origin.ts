import { HttpStatus } from '@nestjs/common'

import { RequestException } from '../shared/exception/request.exception'

/** Where a token credit came from; it decides the order a token debit spends it in. */
export enum TokenOrigin {
  GIFT = 'gift',
  PURCHASED = 'purchased',
  DROPI = 'dropi',
}

export const TOKEN_CURRENCY = 'TKN'

export function isTokenCurrency(currency: unknown): boolean {
  return typeof currency === 'string' && currency.trim().toUpperCase() === TOKEN_CURRENCY
}

/** Throws 422 `TOKEN_WALLET_RESERVED` for `TKN`: only TokenWalletService opens the brand token wallet. */
export function assertNotTokenCurrency(currency: unknown): void {
  if (isTokenCurrency(currency)) {
    throw new RequestException(
      { code: 'TOKEN_WALLET_RESERVED', message: 'Token wallets come from GET /token-wallet' },
      HttpStatus.UNPROCESSABLE_ENTITY,
    )
  }
}
