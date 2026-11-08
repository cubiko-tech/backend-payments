import { ApiProperty } from '@nestjs/swagger'
import { IsUUID, Max, Min, ValidateBy } from 'class-validator'

/** Upper bound of one recharge; at TRM 10,000 plus 19 % it stays far inside `payments.amount`. */
export const MAX_DROPI_RECHARGE_TOKENS = 1_000_000

/** A finite number in hundredths, the precision a token wallet keeps. */
export function isTokenAmount(value: unknown): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  const hundredths = value * 100
  return Math.abs(hundredths - Math.round(hundredths)) < 1e-6
}

// Not `IsNumber({ maxDecimalPlaces })`: class-validator throws on `1e-7`, which has no '.'.
const IsTokenAmount = () =>
  ValidateBy({
    name: 'isTokenAmount',
    validator: {
      validate: isTokenAmount,
      defaultMessage: () => 'tokens must be a number with at most 2 decimals',
    },
  })

export class CreateDropiRechargeDto {
  @ApiProperty({ description: 'Brand the tokens go to; the user must be a member of it' })
  @IsUUID()
  brandId: string

  @ApiProperty({ description: 'Tokens to recharge, at USD 1 each', example: 10 })
  @IsTokenAmount()
  @Min(0.01)
  @Max(MAX_DROPI_RECHARGE_TOKENS)
  tokens: number

  @ApiProperty({ description: 'Id of this request at ROAX Ads; a retry with it gets the same one' })
  @IsUUID()
  requestId: string
}
