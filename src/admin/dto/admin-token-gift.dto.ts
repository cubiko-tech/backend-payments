import { ApiProperty } from '@nestjs/swagger'
import {
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
} from 'class-validator'
import { HasAtMostTwoDecimals, MAX_MONEY_AMOUNT, MONEY_INPUT } from './money-input'

export class GiftTokensDto {
  @ApiProperty({ description: 'Tokens to give, two decimals at most', example: 20 })
  @IsNumber(MONEY_INPUT)
  @HasAtMostTwoDecimals()
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  amount: number

  @ApiProperty({ description: 'Why the brand receives the tokens; kept on the movement' })
  @IsString()
  @Matches(/\S/, { message: 'reason must not be blank' })
  @MaxLength(500)
  reason: string

  @ApiProperty({ description: 'Repeating it returns the first gift instead of a second one' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey: string
}
