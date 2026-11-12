import { IsNotEmpty, IsObject, IsOptional, IsString, Length, MaxLength } from 'class-validator'

export class CreateWalletDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  userId?: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provider: string

  @IsOptional()
  @IsString()
  @MaxLength(200)
  providerWalletId?: string

  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  currency: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>
}
