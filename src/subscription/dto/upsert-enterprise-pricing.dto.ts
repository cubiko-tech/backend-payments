import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  MaxLength,
} from 'class-validator'

export class UpsertEnterprisePricingDto {
  @ApiProperty({ description: 'Monthly negotiated price', example: 299 })
  @IsNumber()
  @IsPositive()
  monthlyPrice: number

  @ApiPropertyOptional({ description: 'ISO 3-letter currency code', example: 'USD' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  currency?: string

  @ApiPropertyOptional({ description: 'Negotiated by actor or sales rep' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  negotiatedBy?: string

  @ApiPropertyOptional({ description: 'ISO 8601 expiration date for pricing' })
  @IsOptional()
  @IsDateString()
  validUntil?: string

  @ApiPropertyOptional({ description: 'Negotiation notes' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string
}
