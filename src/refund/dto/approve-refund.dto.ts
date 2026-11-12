import { IsOptional, IsString, MaxLength } from 'class-validator'

export class ApproveRefundDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  approvedBy?: string
}
