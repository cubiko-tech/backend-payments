import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator'
import { InvoiceType } from '../entities/invoice.entity'

export class ListInvoicesQueryDto {
  @ApiPropertyOptional({ description: 'Brand ID when filtering by query parameter' })
  @IsOptional()
  @IsString()
  brandId?: string

  @ApiPropertyOptional({ description: 'Page number (1-indexed)', minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number

  @ApiPropertyOptional({ description: 'Items per page', minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number

  @ApiPropertyOptional({ description: 'Invoice type filter', enum: InvoiceType })
  @IsOptional()
  @IsEnum(InvoiceType)
  type?: InvoiceType
}
