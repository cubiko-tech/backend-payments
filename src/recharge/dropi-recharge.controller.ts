import { Body, Controller, HttpStatus, Logger, Post, Req, Res, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { Response } from 'express'

import { ClientPlatformService } from '../client/client-platform.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { assertValidBrandId } from '../shared/auth/brand-scope.util'
import {
  RequireOnBehalfOfUser,
  RequireServiceClient,
  ROAX_ADS_CLIENT,
} from '../shared/auth/require-permission.decorator'
import { RequestException } from '../shared/exception/request.exception'
import { CreateDropiRechargeDto } from './dto/create-dropi-recharge.dto'
import { DropiRechargeService } from './dropi-recharge.service'

@ApiTags('Recharge')
@Controller('recharge/dropi')
@UseGuards(ApiAuthGuard)
@RequireServiceClient(ROAX_ADS_CLIENT)
@RequireOnBehalfOfUser()
export class DropiRechargeController {
  private readonly logger = new Logger(DropiRechargeController.name)

  constructor(
    private readonly recharges: DropiRechargeService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'ROAX Ads opens a pending recharge paid with the Dropi balance' })
  @ApiResponse({ status: 201, description: 'Recharge created pending' })
  @ApiResponse({ status: 200, description: 'Same requestId: the recharge already created' })
  @ApiResponse({ status: 401, description: 'No ROAX Ads credential or no user token' })
  @ApiResponse({ status: 403, description: 'The user is not a member of the brand' })
  @ApiResponse({ status: 409, description: 'requestId already used with other tokens' })
  @ApiResponse({ status: 503, description: 'No TRM or no brand membership lookup' })
  async create(
    @Body() body: CreateDropiRechargeDto,
    @Req() req: { onBehalfOf: { id: string } },
    @Res({ passthrough: true }) res: Response,
  ) {
    const brandId = assertValidBrandId(body.brandId)
    const userId = req.onBehalfOf.id
    // Asked of platform even for a super admin: a leaked credential plus any token must not do.
    if (!(await this.platformClient.canViewBrandCredit(userId, brandId))) {
      this.logger.warn(`Forbidden recharge: user=${userId} brandId=${brandId}`)
      throw new RequestException({ error: 'forbidden', code: 'forbidden' }, HttpStatus.FORBIDDEN)
    }
    const { created, recharge } = await this.recharges.create(
      brandId,
      userId,
      body.tokens,
      body.requestId,
    )
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK)
    return { data: recharge }
  }
}
