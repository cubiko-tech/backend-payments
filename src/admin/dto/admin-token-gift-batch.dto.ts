import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
} from 'class-validator'
import { MaxGiftTokensPerBrand } from './admin-token-gift.dto'
import { HasAtMostTwoDecimals, MAX_MONEY_AMOUNT, MONEY_INPUT } from './money-input'

export const GIFT_BATCH_FILTER_KINDS = ['all_open', 'brands'] as const
export type GiftBatchFilterKind = (typeof GIFT_BATCH_FILTER_KINDS)[number]

function ForbidBrandIdsOnAllOpen(): PropertyDecorator {
  return ValidateBy({
    name: 'forbidBrandIdsOnAllOpen',
    validator: {
      validate: (value: unknown, args?: ValidationArguments) => {
        const obj = args?.object as GiftBatchFilterDto | undefined
        if (obj?.kind === 'all_open') return value === undefined
        return true
      },
      defaultMessage: () => 'brandIds is not allowed when filter kind is all_open',
    },
  })
}

export class GiftBatchFilterDto {
  @ApiProperty({ enum: GIFT_BATCH_FILTER_KINDS, example: 'all_open' })
  @IsIn(GIFT_BATCH_FILTER_KINDS)
  kind: GiftBatchFilterKind

  @ApiPropertyOptional({
    type: [String],
    description: '1 to 100 unique brand UUIDs when kind is brands',
  })
  @ForbidBrandIdsOnAllOpen()
  @ValidateIf((o: GiftBatchFilterDto) => o.kind === 'brands' || o.brandIds !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  brandIds?: string[]
}

export class PreviewGiftBatchDto {
  @ApiProperty({ type: GiftBatchFilterDto })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => GiftBatchFilterDto)
  filter: GiftBatchFilterDto

  @ApiProperty({ description: 'Gift tokens per brand, two decimals at most', example: 50 })
  @IsNumber(MONEY_INPUT)
  @HasAtMostTwoDecimals()
  @IsPositive()
  @MaxGiftTokensPerBrand()
  amount: number
}

export class CreateGiftBatchDto extends PreviewGiftBatchDto {
  @ApiProperty({
    description: 'Total tokens confirmed by the super admin (brandCount * amount)',
    example: 200,
  })
  @IsNumber(MONEY_INPUT)
  @HasAtMostTwoDecimals()
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  confirmedTotalTokens: number

  @ApiProperty({ description: 'Why the brands receive the gift tokens; kept on each movement' })
  @IsString()
  @Matches(/\S/, { message: 'reason must not be blank' })
  @MaxLength(500)
  reason: string

  @ApiProperty({ description: 'Repeating it returns the same batch operation' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey: string
}

export class GetGiftBatchQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}
