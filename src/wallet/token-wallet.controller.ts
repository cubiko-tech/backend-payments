import { Controller, Get, Logger, Query, Req, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { ClientPlatformService } from '../client/client-platform.service'
import { assertBrandAccess, resolveRequestBrandId } from '../shared/auth/brand-scope.util'
import { TokenWalletService } from './token-wallet.service'

@ApiTags('Token wallet')
@Controller('token-wallet')
@UseGuards(ApiAuthGuard)
export class TokenWalletController {
  private readonly logger = new Logger(TokenWalletController.name)

  constructor(
    private readonly tokenWallets: TokenWalletService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Token wallet of a brand with its balance by origin; created once' })
  @ApiResponse({ status: 200, description: 'Token wallet of the brand' })
  @ApiResponse({ status: 403, description: 'The caller does not belong to the brand' })
  async get(@Query('brandId') brandId?: string, @Req() req?: any) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      resolveRequestBrandId(req, brandId),
      'GET /token-wallet',
    )
    const userId = req?.user?.id ?? validBrandId
    return { data: await this.tokenWallets.getOrCreate(validBrandId, userId) }
  }
}
