import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'

import { CreditActivationRequestStatus } from '../credit.types'

const STATUSES: CreditActivationRequestStatus[] = [
  'pending',
  'contacted',
  'qualified',
  'rejected',
  'activated',
]

export class UpdateActivationRequestDto {
  @IsOptional()
  @IsString()
  @IsIn(STATUSES)
  status?: CreditActivationRequestStatus

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string

  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactedBy?: string
}
