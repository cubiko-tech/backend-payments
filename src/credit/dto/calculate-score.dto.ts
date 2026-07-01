import { IsString, Matches } from 'class-validator'

export class CalculateScoreDto {
  @IsString()
  brandId: string

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'periodStart debe ser YYYY-MM-DD' })
  periodStart: string

  /** EXCLUSIVO: primer día del mes siguiente al último mes a evaluar. */
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'periodEnd debe ser YYYY-MM-DD' })
  periodEnd: string
}
