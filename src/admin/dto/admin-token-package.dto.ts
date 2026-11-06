import { ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator'
import { MIN_PACKAGE_PRICE_USD } from '../../wallet/token-package.service'

const MONEY = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }

export class UpdateTokenPackageDto {
  @ApiPropertyOptional({ description: 'Name shown to the buyer' })
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'label must not be blank' })
  @MaxLength(100)
  label?: string

  @ApiPropertyOptional({ description: 'Price in USD, at least 10', example: 25 })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(MIN_PACKAGE_PRICE_USD)
  priceUsd?: number

  @ApiPropertyOptional({ description: 'Tokens the price pays for, credited as purchased' })
  @IsOptional()
  @IsNumber(MONEY)
  @IsPositive()
  purchasedTokens?: number

  @ApiPropertyOptional({ description: 'Extra tokens credited as gift; not invoiced' })
  @IsOptional()
  @IsNumber(MONEY)
  @Min(0)
  bonusTokens?: number

  @ApiPropertyOptional({ description: 'Whether buyers can see and buy it' })
  @IsOptional()
  @IsBoolean()
  active?: boolean
}
