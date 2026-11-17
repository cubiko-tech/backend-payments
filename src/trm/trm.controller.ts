import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireServiceClient, ROAX_ADS_CLIENT } from '../shared/auth/require-permission.decorator'
import { TrmWeeklyService } from './trm-weekly.service'
import { TrmService } from './trm.service'

/** How long ROAX Ads waits for the day's TRM before it is answered the week's. */
const DAILY_TIMEOUT_MS = 3000

export interface UsdCopQuote {
  /** COP per 1 USD. */
  rate: number
  /** Day the rate is valid from, `YYYY-MM-DD`. */
  date: string
  /** `daily`: the TRM in force today; `weekly`: the one the week started with, the day's being unreadable. */
  source: 'daily' | 'weekly'
}

@ApiTags('trm')
@Controller('trm')
@UseGuards(ApiAuthGuard)
@RequireServiceClient(ROAX_ADS_CLIENT)
export class TrmController {
  constructor(
    private readonly trm: TrmService,
    private readonly weekly: TrmWeeklyService,
  ) {}

  @Get('usd-cop')
  @ApiOperation({
    summary: "TRM for ROAX Ads to show pesos: the day's, or the week's when it fails",
  })
  @ApiResponse({ status: 200, description: "The rate and whether it is the day's or the week's" })
  @ApiResponse({
    status: 503,
    description: "Neither the day's TRM nor any weekly one is available",
  })
  async usdCop(): Promise<UsdCopQuote> {
    try {
      return { ...(await this.trm.getUsdCopRate(DAILY_TIMEOUT_MS)), source: 'daily' }
    } catch (error) {
      const week = await this.weekly.latest()
      if (!week) throw error
      return { rate: week.rate, date: week.rateDate, source: 'weekly' }
    }
  }
}
