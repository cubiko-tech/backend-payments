import { IsIn, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator'
import { BureauBand } from '../domain/scale-config.types'

const BANDS: BureauBand[] = ['veto', 'high_risk', 'medium_risk', 'clear']

/**
 * Carga un check de buró. `band` explícita o `rawScore` (se mapea a banda con los
 * umbrales del provider) — al menos uno. La regla de consentimiento se valida en
 * el service.
 */
export class CreateBureauCheckDto {
  @IsString()
  brandId: string

  @IsOptional()
  @IsString()
  provider?: string

  @IsOptional()
  @IsNumber()
  @Min(0)
  rawScore?: number

  @IsOptional()
  @IsInt()
  @Min(1)
  scaleMax?: number

  @IsOptional()
  @IsIn(BANDS)
  band?: BureauBand

  @IsOptional()
  @IsInt()
  @Min(1)
  validDays?: number
}
