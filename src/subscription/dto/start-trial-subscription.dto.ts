import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsNotEmpty, IsOptional, IsString } from 'class-validator'

export class StartTrialSubscriptionDto {
  @ApiProperty({ description: 'Brand ID', example: 'brand-123' })
  @IsString()
  @IsNotEmpty()
  brandId: string

  @ApiProperty({ description: 'User ID', example: 'user-123' })
  @IsString()
  @IsNotEmpty()
  userId: string

  @ApiProperty({ description: 'Plan slug', example: 'pro' })
  @IsString()
  @IsNotEmpty()
  planSlug: string

  @ApiPropertyOptional({ description: 'Optional provider rejected at domain layer for trials' })
  @IsOptional()
  @IsString()
  provider?: string

  @ApiPropertyOptional({ description: 'Optional wallet ID rejected at domain layer for trials' })
  @IsOptional()
  @IsString()
  walletId?: string

  @ApiPropertyOptional({ description: 'Billing phone number', example: '+573001234567' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  billingPhone?: string
}
