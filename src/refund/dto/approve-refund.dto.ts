import { IsNotEmpty, IsString, MaxLength } from 'class-validator'

export class ApproveRefundDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  approvedBy: string
}
