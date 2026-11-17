import { ApiProperty } from '@nestjs/swagger'
import { IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator'

import { IsTokenAmount } from '../../recharge/dto/create-dropi-recharge.dto'
import { MAX_SERVICE_TOKENS, SERVICE_KEY_PATTERN } from './debit-tokens.dto'

export class RefundDebitDto {
  @ApiProperty({ description: 'Brand of the debit' })
  @IsUUID()
  brandId: string

  @ApiProperty({ description: 'Key the debit was made with' })
  @IsString()
  @MaxLength(100)
  @Matches(SERVICE_KEY_PATTERN)
  debitKey: string

  @ApiProperty({ description: 'Tokens to give back; all refunds together stay within the debit' })
  @IsTokenAmount()
  @Min(0.01)
  @Max(MAX_SERVICE_TOKENS)
  tokens: number

  @ApiProperty({ description: 'Key of this refund; a retry with it gets the same one' })
  @IsString()
  @MaxLength(100)
  @Matches(SERVICE_KEY_PATTERN)
  refundKey: string
}
