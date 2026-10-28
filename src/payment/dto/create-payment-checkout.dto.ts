import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Length,
  MaxLength,
} from 'class-validator'
import { PaymentProvider, PaymentPurpose } from '../entities/payment.entity'

export class CreatePaymentCheckoutDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  userId?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  walletId?: string

  @IsEnum(PaymentProvider)
  provider: PaymentProvider

  @IsNumber()
  @IsPositive()
  amount: number

  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  currency: string

  @IsEnum(PaymentPurpose)
  purpose: PaymentPurpose

  @IsOptional()
  @IsString()
  @MaxLength(100)
  purposeId?: string

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>
}
