import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator'
import { TransactionType } from '../../transaction/entities/transaction.entity'

export class ListTokenWalletMovementsQueryDto {
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

  @ApiPropertyOptional({ description: 'Transaction type filter', enum: TransactionType })
  @IsOptional()
  @IsEnum(TransactionType)
  type?: TransactionType

  @ApiPropertyOptional({ description: 'ISO 8601 lower date bound (inclusive)' })
  @IsOptional()
  @IsDateString({ strict: true })
  dateFrom?: string

  @ApiPropertyOptional({ description: 'ISO 8601 upper date bound (inclusive)' })
  @IsOptional()
  @IsDateString({ strict: true })
  dateTo?: string
}
