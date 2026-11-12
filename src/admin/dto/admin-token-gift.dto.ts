import { ApiProperty } from '@nestjs/swagger'
import {
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  ValidateBy,
  ValidationOptions,
} from 'class-validator'
import { tokenGiftLimits } from '../../wallet/token-gift-limits'
import { HasAtMostTwoDecimals, MAX_MONEY_AMOUNT, MONEY_INPUT } from './money-input'

/**
 * Evaluates `TOKEN_GIFT_MAX_TOKENS_PER_BRAND` on each call instead of at import time so runtime
 * configuration and tests that change `process.env` take effect without reloading the module.
 */
export function MaxGiftTokensPerBrand(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'maxGiftTokensPerBrand',
      validator: {
        validate: (value: unknown) =>
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value <= tokenGiftLimits().maxTokensPerBrand,
        defaultMessage: () =>
          `$property must not exceed ${tokenGiftLimits().maxTokensPerBrand} tokens per brand`,
      },
    },
    options,
  )
}

export class GiftTokensDto {
  @ApiProperty({ description: 'Tokens to give, two decimals at most', example: 20 })
  @IsNumber(MONEY_INPUT)
  @HasAtMostTwoDecimals()
  @IsPositive()
  @MaxGiftTokensPerBrand()
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

export class DebitGiftTokensDto {
  @ApiProperty({ description: 'Gift tokens to remove, two decimals at most', example: 20 })
  @IsNumber(MONEY_INPUT)
  @HasAtMostTwoDecimals()
  @IsPositive()
  @Max(MAX_MONEY_AMOUNT)
  amount: number

  @ApiProperty({ description: 'Why the brand loses the gift tokens; kept on the movement' })
  @IsString()
  @Matches(/\S/, { message: 'reason must not be blank' })
  @MaxLength(500)
  reason: string

  @ApiProperty({ description: 'Repeating it returns the first debit instead of a second one' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  idempotencyKey: string
}
