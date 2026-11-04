import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator'

export class AdminCreateWalletDto {
  @ApiProperty({ description: 'Brand ID', example: 'brand-123' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
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
  @IsOptional()
  @IsNumber()
  @Min(0)
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

  @ApiProperty({ description: 'Adjustment amount', example: 50000 })
  @IsNumber()
  @IsPositive()
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
}
