import { Type } from 'class-transformer'
import {
  Allow,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator'

import type { CheckoutRequest } from '../checkout.service'

/** Two orders of magnitude under the `decimal(15,2)` money columns, leaving room for a wallet balance. */
export const MAX_CHECKOUT_AMOUNT = 100_000_000_000

const PURPOSES: CheckoutRequest['purpose'][] = [
  'plan_purchase',
  'wallet_recharge',
  'service_payment',
  'token_package',
]
const PROVIDERS: CheckoutRequest['provider'][] = [
  'wallet',
  'stripe',
  'mercadopago',
  'dropi',
  'confio',
]

export class CheckoutBuyerDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string

  // Format is not checked here: Confio's buyer builder validates email and E.164 phone.
  @IsOptional()
  @IsString()
  @MaxLength(254)
  email?: string

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phoneNumber?: string
}

/**
 * Body of `POST /checkout`. Checks shape and types; the service keeps its domain codes
 * (`INVALID_BRAND_ID`, `INVALID_PLAN_SLUG`, `INVALID_AMOUNT`, `MISSING_WALLET_ID`), so the
 * fields those guards own only have to be strings, or numbers, to reach them.
 */
export class CheckoutRequestDto {
  @IsOptional()
  @IsString()
  brandId: string

  @IsOptional()
  @IsString()
  userId: string

  @IsIn(PURPOSES)
  purpose: CheckoutRequest['purpose']

  @IsIn(PROVIDERS)
  provider: CheckoutRequest['provider']

  @IsOptional()
  @IsString()
  planSlug?: string

  // Only the ceiling: zero, negatives and non-numbers keep the service's INVALID_AMOUNT.
  @ValidateIf((dto: CheckoutRequestDto) => typeof dto.amount === 'number')
  @Max(MAX_CHECKOUT_AMOUNT)
  amount?: number

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string

  // A blank walletId reaches the service, which answers MISSING_WALLET_ID.
  @ValidateIf((dto: CheckoutRequestDto) => !isBlankString(dto.walletId))
  @IsOptional()
  @IsUUID()
  walletId?: string

  @IsOptional()
  @IsUUID()
  packageId?: string

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  successUrl?: string

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  cancelUrl?: string

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => CheckoutBuyerDto)
  buyer?: CheckoutBuyerDto

  // Accepted and discarded by the controller: the key comes from the header, renewal only from the cron.
  @Allow()
  idempotencyKey?: string

  @Allow()
  renewal?: boolean
}

function isBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() === ''
}
