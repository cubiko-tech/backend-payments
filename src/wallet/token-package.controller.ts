import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { TokenPackageService } from './token-package.service'

@ApiTags('Token packages')
@Controller('token-packages')
@UseGuards(ApiAuthGuard)
export class TokenPackageController {
  constructor(private readonly packages: TokenPackageService) {}

  @Get()
  @ApiOperation({ summary: 'Active token packages a brand can buy, cheapest first' })
  @ApiResponse({ status: 200, description: 'Price in USD, purchased tokens and bonus of each' })
  async list() {
    return { data: await this.packages.listActive() }
  }
}
