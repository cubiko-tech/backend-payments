import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator'
import { HasAtMostTwoDecimals, MAX_MONEY_AMOUNT, MONEY_INPUT } from './money-input'

export class AdminCreateWalletDto {
  @ApiProperty({ description: 'Brand ID', example: '11111111-1111-4111-8111-111111111111' })
  @IsUUID()
  brandId: string

  @ApiPropertyOptional({ description: 'User ID', example: 'user-123' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  userId?: string

  @ApiProperty({ description: 'Payment provider', example: 'dropi' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provider: string

  @ApiProperty({ description: 'ISO currency code', example: 'COP' })
  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  currency: string

  @ApiPropertyOptional({ description: 'Wallet label', example: 'Main wallet' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string

  @ApiPropertyOptional({ description: 'Initial wallet balance', example: 0 })
  @ValidateIf((_, value) => value !== undefined)
  @IsNumber(MONEY_INPUT)
  @HasAtMostTwoDecimals()
  @Min(0)
  @Max(MAX_MONEY_AMOUNT)
  balance?: number

  @ApiPropertyOptional({ description: 'Optional caller actor ignored in favor of session' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  adminUserId?: string
}

export class AdjustWalletDto {
  @ApiPropertyOptional({ description: 'Optional wallet ID echoed by admin client' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  id?: string

  @ApiPropertyOptional({ description: 'Optional caller actor ignored in favor of session' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  adminUserId?: string

  @ApiProperty({ description: 'Adjustment direction', enum: ['credit', 'debit'] })
  @IsIn(['credit', 'debit'])
  type: 'credit' | 'debit'

  @ApiProperty({ description: 'Adjustment amount, two decimals at most', example: 50000 })
  @IsNumber(MONEY_INPUT)
  @HasAtMostTwoDecimals()
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  amount: number

  @ApiPropertyOptional({ description: 'Adjustment reason or description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string

  @ApiPropertyOptional({ description: 'Adjustment category' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string

  @ApiProperty({ description: 'Repeating it returns the first adjustment instead of a second one' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey: string
}
