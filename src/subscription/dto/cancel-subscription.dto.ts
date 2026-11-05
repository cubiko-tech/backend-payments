import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString } from 'class-validator'

export class CancelSubscriptionDto {
  @ApiPropertyOptional({ description: 'Brand ID when called by operator or service token' })
  @IsOptional()
  @IsString()
  brandId?: string

  @ApiPropertyOptional({ description: 'Cancellation reason validated by domain service' })
  @IsOptional()
  @IsString()
  reason?: string

  @ApiPropertyOptional({ description: 'Optional actor echoed by caller' })
  @IsOptional()
  @IsString()
  triggeredBy?: string
}

export class ReactivateSubscriptionDto {
  @ApiPropertyOptional({ description: 'Brand ID when called by operator or service token' })
  @IsOptional()
  @IsString()
  brandId?: string

  @ApiPropertyOptional({ description: 'Optional actor echoed by caller' })
  @IsOptional()
  @IsString()
  triggeredBy?: string
}
