import { IsString, Matches } from 'class-validator'

/**
 * Dispara un run masivo para un período. `periodEnd` es EXCLUSIVO: el primer día
 * del mes siguiente al último mes a evaluar (mismo contrato que el cálculo
 * individual). Ver DISEÑO_SCORING_CREDITO §6.1.
 */
export class CreateRunDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'periodStart debe ser YYYY-MM-DD' })
  periodStart: string

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'periodEnd debe ser YYYY-MM-DD' })
  periodEnd: string
}
