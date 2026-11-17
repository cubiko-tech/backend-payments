import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'

import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireServiceClient, ROAX_ADS_CLIENT } from '../shared/auth/require-permission.decorator'
import { DropiRechargeResultService } from './dropi-recharge-result.service'
import { ReportDropiRechargeResultDto } from './dto/report-dropi-recharge-result.dto'

/**
 * ROAX Ads reports what its charge in dropi-wallet did. Only its credential: the brand was fixed
 * when the recharge was created, and the user's token may have expired by the time the result comes.
 */
@ApiTags('Recharge')
@Controller('recharge/dropi')
@UseGuards(ApiAuthGuard)
@RequireServiceClient(ROAX_ADS_CLIENT)
export class DropiRechargeResultController {
  constructor(private readonly results: DropiRechargeResultService) {}

  @Post(':id/result')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'ROAX Ads reports the result of a recharge paid with the Dropi balance',
  })
  @ApiResponse({ status: 200, description: 'Recharge closed, or already closed with this result' })
  @ApiResponse({ status: 401, description: 'No ROAX Ads credential' })
  @ApiResponse({ status: 404, description: 'RECHARGE_NOT_FOUND: unknown or of another brand' })
  @ApiResponse({ status: 409, description: 'RECHARGE_ALREADY_CLOSED: closed with another result' })
  @ApiResponse({ status: 422, description: 'RECHARGE_AMOUNT_MISMATCH or WALLET_CLOSED' })
  async report(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReportDropiRechargeResultDto) {
    return { data: await this.results.report(id, body) }
  }
}
