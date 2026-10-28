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
import { RefundReason } from '../entities/refund.entity'

export class RequestRefundDto {
  @IsString()
  @IsNotEmpty()
  paymentId: string

  @IsNumber()
  @IsPositive()
  amount: number

  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  currency: string

  @IsEnum(RefundReason)
  reason: RefundReason

  @IsOptional()
  @IsString()
  @MaxLength(50)
  provider?: string

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  requestedBy?: string

  @IsOptional()
  @IsString()
  description?: string

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>
}
