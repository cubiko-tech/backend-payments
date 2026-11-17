import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsEnum, IsString, IsUUID, Length, Max, Min, ValidateBy, ValidateIf } from 'class-validator'

import { DropiChargeResult } from '../dropi-recharge-result'
import { isTokenAmount } from './create-dropi-recharge.dto'

/**
 * Above any recharge `MAX_DROPI_RECHARGE_TOKENS` can price, and below `payments.amount`
 * (`decimal(15,2)`), so an absurd amount is a 400 and never reaches the database.
 */
export const MAX_DROPI_RECHARGE_AMOUNT = 100_000_000_000

const IsPesoAmount = () =>
  ValidateBy({
    name: 'isPesoAmount',
    validator: {
      validate: isTokenAmount,
      defaultMessage: () => 'amount must be a number with at most 2 decimals',
    },
  })

export class ReportDropiRechargeResultDto {
  @ApiProperty({ description: 'Brand the recharge was created for' })
  @IsUUID()
  brandId: string

  @ApiProperty({ enum: DropiChargeResult, description: 'What the charge in dropi-wallet did' })
  @IsEnum(DropiChargeResult)
  status: DropiChargeResult

  @ApiProperty({ description: 'Pesos Dropi charged, VAT included; must match the recharge' })
  @IsPesoAmount()
  @Min(0.01)
  @Max(MAX_DROPI_RECHARGE_AMOUNT)
  amount: number

  @ApiPropertyOptional({ description: 'Id of the operation in dropi-wallet; required if charged' })
  @ValidateIf(
    (dto) => dto.status === DropiChargeResult.CHARGED || dto.dropiOperationId !== undefined,
  )
  @IsString()
  @Length(1, 255)
  dropiOperationId?: string
}
