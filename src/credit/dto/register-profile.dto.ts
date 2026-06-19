import { IsOptional, IsString } from 'class-validator'

/** Documento legal del titular para el perfil de crédito de la marca. */
export class RegisterProfileDto {
  @IsString()
  document: string

  @IsString()
  documentType: string

  @IsOptional()
  @IsString()
  country?: string
}
