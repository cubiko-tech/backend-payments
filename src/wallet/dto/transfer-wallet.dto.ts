import { IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator'

export class TransferWalletDto {
  @IsString()
  @IsNotEmpty()
  fromWalletId: string

  @IsString()
  @IsNotEmpty()
  toWalletId: string

  @IsNumber()
  @IsPositive()
  amount: number

  @IsOptional()
  @IsString()
  description?: string
}
