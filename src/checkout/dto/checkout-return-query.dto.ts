import { IsUUID, ValidateIf } from 'class-validator'

export class CheckoutReturnQueryDto {
  @ValidateIf((dto: CheckoutReturnQueryDto) => dto.paymentId !== undefined || !dto.correlation_id)
  @IsUUID()
  paymentId?: string

  /** ConfioPagos redirect alias for `paymentId`. */
  @ValidateIf((dto: CheckoutReturnQueryDto) => dto.correlation_id !== undefined)
  @IsUUID()
  correlation_id?: string
}
