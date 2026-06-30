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

  // Quién contactó al lead (dato de negocio: puede no ser el admin logueado).
  // La trazabilidad de quién ejecutó la acción la lleva el audit log aparte.
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactedBy?: string
}
