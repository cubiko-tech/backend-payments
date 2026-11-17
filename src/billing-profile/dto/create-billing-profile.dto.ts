import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator'
import { TaxIdType, TaxRegime } from '../entities/billingProfile.entity'

export class CreateBillingProfileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  legalName: string

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  taxId: string

  @IsEnum(TaxIdType)
  taxIdType: TaxIdType

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  state?: string

  @IsString()
  @Length(2, 2)
  country: string

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string

  @IsEmail()
  @MaxLength(200)
  email: string

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string

  @IsOptional()
  @IsEnum(TaxRegime)
  taxRegime?: TaxRegime

  @IsOptional()
  @IsString()
  @MaxLength(100)
  dianResolutionNumber?: string

  @IsOptional()
  @IsString()
  @MaxLength(10)
  dianResolutionPrefix?: string

  @IsOptional()
  @IsInt()
  dianResolutionRangeFrom?: number

  @IsOptional()
  @IsInt()
  dianResolutionRangeTo?: number

  @IsOptional()
  @IsDateString()
  dianResolutionDate?: Date

  @IsOptional()
  @IsDateString()
  dianResolutionExpiry?: Date
}
