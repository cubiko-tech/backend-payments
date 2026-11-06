import { ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'
import { MIN_PACKAGE_PRICE_USD } from '../../wallet/token-package.service'
import { MAX_MONEY_AMOUNT, MONEY_INPUT } from './money-input'

export class UpdateTokenPackageDto {
  @ApiPropertyOptional({ description: 'Name shown to the buyer' })
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'label must not be blank' })
  @MaxLength(100)
  label?: string

  @ApiPropertyOptional({ description: 'Price in USD, at least 10', example: 25 })
  @IsOptional()
  @IsNumber(MONEY_INPUT)
  @Min(MIN_PACKAGE_PRICE_USD)
  @Max(MAX_MONEY_AMOUNT)
  priceUsd?: number

  @ApiPropertyOptional({ description: 'Tokens the price pays for, credited as purchased' })
  @IsOptional()
  @IsNumber(MONEY_INPUT)
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  purchasedTokens?: number

  @ApiPropertyOptional({ description: 'Extra tokens credited as gift; not invoiced' })
  @IsOptional()
  @IsNumber(MONEY_INPUT)
  @Min(0)
  @Max(MAX_MONEY_AMOUNT)
  bonusTokens?: number

  @ApiPropertyOptional({ description: 'Whether buyers can see and buy it' })
  @IsOptional()
  @IsBoolean()
  active?: boolean
}
