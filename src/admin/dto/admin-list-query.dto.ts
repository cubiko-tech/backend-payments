import { ApiPropertyOptional } from '@nestjs/swagger'
import { Transform } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator'
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../../payment/entities/payment.entity'
import {
  SubscriptionProvider,
  SubscriptionStatus,
} from '../../subscription/entities/subscription.entity'
import { WalletStatus } from '../../wallet/entities/wallet.entity'

export const MAX_LIST_PAGE = 100_000
export const MAX_LIST_PER_PAGE = 100
export const MAX_LIST_BRAND_IDS = 100

export const WALLET_LIST_ORDER_FIELDS = ['createdAt', 'balance', 'status', 'provider', 'currency']
export const SUBSCRIPTION_LIST_ORDER_FIELDS = [
  'createdAt',
  'currentPeriodEnd',
  'status',
  'planSlug',
  'retryCount',
]
export const PAYMENT_LIST_ORDER_FIELDS = ['createdAt', 'amount', 'status', 'provider', 'paidAt']

type Param = { value: unknown }

// A blank query value means no filter, so `status=` lists everything instead of a 400.
const isBlank = (value: unknown) => typeof value === 'string' && value.trim() === ''

const blankAsAbsent = ({ value }: Param) => (isBlank(value) ? undefined : value)

const toInteger = ({ value }: Param) => {
  if (value === undefined || isBlank(value)) return undefined
  return typeof value === 'string' ? Number(value) : value
}

const toUpper = ({ value }: Param) => {
  if (isBlank(value)) return undefined
  return typeof value === 'string' ? value.toUpperCase() : value
}

// Takes `a,b` and the repeated parameter alike; anything that is not text is left for the validator.
const toBrandIdList = ({ value }: Param) => {
  if (value === undefined) return undefined
  const parts = Array.isArray(value) ? value : [value]
  if (!parts.every((part) => typeof part === 'string')) return value
  return parts
    .flatMap((part: string) => part.split(','))
    .map((id) => id.trim())
    .filter((id) => id !== '')
}

/** Paging, order and free-text search shared by the admin list routes. */
export class AdminListPageQueryDto {
  @ApiPropertyOptional({ description: 'Page, from 1', example: 1 })
  @IsOptional()
  @Transform(toInteger)
  @IsInt()
  @Min(1)
  @Max(MAX_LIST_PAGE)
  page?: number

  @ApiPropertyOptional({ description: 'Rows per page', example: 20 })
  @IsOptional()
  @Transform(toInteger)
  @IsInt()
  @Min(1)
  @Max(MAX_LIST_PER_PAGE)
  perPage?: number

  @ApiPropertyOptional({ enum: ['ASC', 'DESC'], description: 'Any case' })
  @IsOptional()
  @Transform(toUpper)
  @IsIn(['ASC', 'DESC'])
  order?: 'ASC' | 'DESC'

  @ApiPropertyOptional({ description: 'Contained in the brand id or the label' })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsString()
  @MaxLength(255)
  search?: string
}

export class WalletsListQueryDto extends AdminListPageQueryDto {
  @ApiPropertyOptional({ enum: WalletStatus })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsEnum(WalletStatus)
  status?: WalletStatus

  // The wallet provider column is free varchar (`wallet.entity.ts`), so this checks the shape only.
  @ApiPropertyOptional({ description: 'Provider identifier', example: 'internal' })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsString()
  @MaxLength(50)
  provider?: string

  @ApiPropertyOptional({ description: 'ISO currency code, any case', example: 'TKN' })
  @IsOptional()
  @Transform(toUpper)
  @IsString()
  @Length(3, 3)
  currency?: string

  @ApiPropertyOptional({ enum: WALLET_LIST_ORDER_FIELDS })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsIn(WALLET_LIST_ORDER_FIELDS)
  orderBy?: string

  @ApiPropertyOptional({
    description: `Brand ids, comma separated or repeated, 1 to ${MAX_LIST_BRAND_IDS}`,
    type: [String],
  })
  @IsOptional()
  @Transform(toBrandIdList)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_LIST_BRAND_IDS)
  @IsUUID('all', { each: true })
  brandIds?: string[]
}

export class SubscriptionsListQueryDto extends AdminListPageQueryDto {
  @ApiPropertyOptional({ enum: SubscriptionStatus })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus

  @ApiPropertyOptional({ enum: SubscriptionProvider })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsEnum(SubscriptionProvider)
  provider?: SubscriptionProvider

  @ApiPropertyOptional({ description: 'Plan slug', example: 'pro' })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsString()
  @MaxLength(255)
  planSlug?: string

  @ApiPropertyOptional({ enum: SUBSCRIPTION_LIST_ORDER_FIELDS })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsIn(SUBSCRIPTION_LIST_ORDER_FIELDS)
  orderBy?: string
}

export class PaymentsListQueryDto extends AdminListPageQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsEnum(PaymentStatus)
  status?: PaymentStatus

  @ApiPropertyOptional({ enum: PaymentProvider })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsEnum(PaymentProvider)
  provider?: PaymentProvider

  @ApiPropertyOptional({ enum: PaymentPurpose })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsEnum(PaymentPurpose)
  purpose?: PaymentPurpose

  @ApiPropertyOptional({ enum: PAYMENT_LIST_ORDER_FIELDS })
  @IsOptional()
  @Transform(blankAsAbsent)
  @IsIn(PAYMENT_LIST_ORDER_FIELDS)
  orderBy?: string
}
