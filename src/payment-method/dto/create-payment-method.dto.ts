import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator'
import { PaymentMethodType } from '../entities/paymentMethod.entity'

export class CreatePaymentMethodDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  userId?: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  provider: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  providerMethodId: string

  @IsEnum(PaymentMethodType)
  type: PaymentMethodType

  @IsOptional()
  @IsString()
  @Length(4, 4)
  last4?: string

  @IsOptional()
  @IsString()
  @MaxLength(50)
  brand?: string

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  expiryMonth?: number

  @IsOptional()
  @IsInt()
  expiryYear?: number

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>
}
