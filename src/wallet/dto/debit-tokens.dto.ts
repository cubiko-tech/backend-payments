import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

import { IsTokenAmount } from '../../recharge/dto/create-dropi-recharge.dto'

/** Upper bound of one service debit or refund, far inside `transactions.amount`. */
export const MAX_SERVICE_TOKENS = 1_000_000

/**
 * Shape of a key a service sends. No ':', the separator of the stored key: with it, debit `a:b` and
 * refund `c` would be the same row as debit `a` and refund `b:c`.
 */
export const SERVICE_KEY_PATTERN = /^[A-Za-z0-9._-]{1,100}$/

export class DebitTokensDto {
  @ApiProperty({ description: 'Brand whose token wallet pays; the user must be a member of it' })
  @IsUUID()
  brandId: string

  @ApiProperty({ description: 'Tokens to debit', example: 8 })
  @IsTokenAmount()
  @Min(0.01)
  @Max(MAX_SERVICE_TOKENS)
  tokens: number

  @ApiProperty({ description: 'Key of this debit at ROAX Ads; a retry with it gets the same one' })
  @IsString()
  @MaxLength(100)
  @Matches(SERVICE_KEY_PATTERN)
  idempotencyKey: string

  @ApiPropertyOptional({ description: 'True only inside Dropi: Dropi tokens may then be spent' })
  @IsOptional()
  @IsBoolean()
  inDropi?: boolean
}
