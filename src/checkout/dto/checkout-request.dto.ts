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
  ValidateBy,
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
  'token_amount',
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

  @ValidateIf((dto: CheckoutRequestDto) => dto.packageId !== undefined)
  @IsUUID()
  @ValidateBy({
    name: 'packageIdOnlyForTokenPackage',
    validator: {
      validate: (_value: unknown, args) => {
        const dto = args?.object as CheckoutRequestDto | undefined
        return dto?.purpose === 'token_package' && dto?.tokens === undefined
      },
      defaultMessage: () =>
        'packageId is only allowed for token_package and cannot be combined with tokens',
    },
  })
  packageId?: string

  // Shape and column ceiling at the border (400); the [10, 1_000_000] business range answers 422 in the service.
  @ValidateIf(
    (dto: CheckoutRequestDto) => dto.purpose === 'token_amount' || dto.tokens !== undefined,
  )
  @ValidateBy({
    name: 'isCheckoutTokenNumber',
    validator: {
      validate: (value: unknown, args) => {
        const dto = args?.object as CheckoutRequestDto | undefined
        if (dto?.purpose !== 'token_amount' || dto?.packageId !== undefined) return false
        return (
          typeof value === 'number' &&
          Number.isFinite(value) &&
          !/[eE]/.test(String(value)) &&
          value <= MAX_CHECKOUT_AMOUNT
        )
      },
      defaultMessage: () =>
        'tokens is required for token_amount, cannot be combined with packageId, and must be a non-exponential number within bounds',
    },
  })
  tokens?: number

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
