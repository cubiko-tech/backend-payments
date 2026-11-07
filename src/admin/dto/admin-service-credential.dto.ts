import { ApiProperty } from '@nestjs/swagger'
import { IsBoolean, IsString, Matches } from 'class-validator'
import { SERVICE_CLIENT_PATTERN } from '../../shared/auth/service-credential.service'

const CLIENT_RULE = { message: 'client must be 3 to 50 lowercase letters, digits or dashes' }

export class ServiceClientDto {
  @ApiProperty({ description: 'Name of the calling service', example: 'roax-ads' })
  @IsString()
  @Matches(SERVICE_CLIENT_PATTERN, CLIENT_RULE)
  client: string
}

export class SetServiceCredentialActiveDto {
  @ApiProperty({ description: 'Whether the credential is accepted' })
  @IsBoolean()
  active: boolean
}
