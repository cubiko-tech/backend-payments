import { IsInt, IsOptional, IsString, Max, Min, MaxLength } from 'class-validator'

/** Body of `POST /admin/subscriptions/:id/extend`. 365 matches the admin panel's input limit. */
export class ExtendSubscriptionDto {
  @IsInt()
  @Min(1)
  @Max(365)
  days: number

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string
}
