import { ApiProperty } from '@nestjs/swagger'
import { IsNotEmpty, IsNumber, IsPositive, IsString, Matches, MaxLength } from 'class-validator'

export class GiftTokensDto {
  @ApiProperty({ description: 'Tokens to give', example: 20 })
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @IsPositive()
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
