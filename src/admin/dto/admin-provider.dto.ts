import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator'

export class CreateProviderConfigDto {
  @ApiProperty({ description: 'ISO 2-letter country code', example: 'CO' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 2)
  country: string

  @ApiProperty({ description: 'Provider identifier', example: 'stripe' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provider: string

  @ApiPropertyOptional({ description: 'Whether the provider is active', default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean

  @ApiPropertyOptional({ description: 'Provider priority order', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number

  @ApiPropertyOptional({ description: 'Additional provider metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>
}

export class UpdateProviderConfigDto {
  @ApiPropertyOptional({ description: 'Whether the provider is active' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean

  @ApiPropertyOptional({ description: 'Provider priority order' })
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number

  @ApiPropertyOptional({ description: 'Additional provider metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>
}
