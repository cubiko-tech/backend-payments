import { IsBoolean, IsObject, IsOptional } from 'class-validator'
import { ScaleConfig } from '../domain/scale-config.types'

/**
 * Crea una versión nueva de escala. `config` es el objeto completo (pesos,
 * escalas, vetos, niveles); se valida en el service (validateScaleConfig).
 * `activate` la deja activa al guardar (retira la anterior).
 */
export class CreateScaleVersionDto {
  @IsObject()
  config: ScaleConfig

  @IsOptional()
  @IsBoolean()
  activate?: boolean
}
