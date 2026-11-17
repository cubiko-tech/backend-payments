import { ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { WebhookStatus } from '../entities/webhookEvent.entity'

export class ListWebhookEventsQueryDto {
  @ApiPropertyOptional({ description: 'Webhook status filter', enum: WebhookStatus })
  @IsOptional()
  @IsEnum(WebhookStatus)
  status?: WebhookStatus

  @ApiPropertyOptional({ description: 'Provider filter', example: 'stripe' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  provider?: string

  @ApiPropertyOptional({ description: 'Maximum events to return', maximum: 100, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}

export class ListFailedWebhooksQueryDto {
  @ApiPropertyOptional({
    description: 'Maximum failed events to return',
    maximum: 100,
    default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}
