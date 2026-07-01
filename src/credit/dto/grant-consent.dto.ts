import { IsString } from 'class-validator'

/** Constancia de consentimiento habeas data del titular (Leyes 1266/1581). */
export class GrantConsentDto {
  @IsString()
  version: string

  @IsString()
  source: string
}
