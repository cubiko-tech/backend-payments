import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator'

export class ListPendingDocumentsQueryDto {
  @ApiPropertyOptional({ description: 'Maximum documents to return', maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}

export class VerifyLegalDocumentDto {
  @ApiPropertyOptional({ description: 'Optional verifier identifier ignored in favor of session' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  verifiedBy?: string
}

export class RejectLegalDocumentDto {
  @ApiPropertyOptional({ description: 'Optional verifier identifier ignored in favor of session' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  verifiedBy?: string

  @ApiProperty({ description: 'Rejection reason', example: 'Document is expired' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string
}

export class UploadLegalDocumentDto {
  @ApiProperty({ description: 'ISO 2-letter country code', example: 'CO' })
  @IsString()
  @IsNotEmpty()
  @Length(2, 2)
  country: string

  @ApiProperty({ description: 'Legal document type', example: 'RUT' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  documentType: string

  @ApiProperty({ description: 'HTTPS document URL', example: 'https://cdn.example.com/rut.pdf' })
  @IsString()
  @IsNotEmpty()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2048)
  documentUrl: string
}
