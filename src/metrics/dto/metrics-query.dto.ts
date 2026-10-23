import { Transform } from 'class-transformer'
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator'

export const MAX_METRICS_DAYS = 365
export const MAX_METRICS_MONTHS = 60

const toNumericParam = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined
  if (typeof value === 'number') return value
  if (typeof value === 'string' && value.trim() !== '') {
    return Number(value)
  }
  return NaN
}

export class MetricsDaysQueryDto {
  @IsOptional()
  @Transform(toNumericParam)
  @IsInt()
  @Min(1)
  @Max(MAX_METRICS_DAYS)
  days?: number
}

export class MetricsMonthsQueryDto {
  @IsOptional()
  @Transform(toNumericParam)
  @IsInt()
  @Min(1)
  @Max(MAX_METRICS_MONTHS)
  months?: number
}

export class MetricsHistoryQueryDto extends MetricsDaysQueryDto {
  @IsOptional()
  @IsString()
  type?: string
}
