import { Body, Controller, Param, ParseUUIDPipe, Patch, Req, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { AuditService } from '../audit/audit.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireSessionUser, RequireSuperAdmin } from '../shared/auth/require-permission.decorator'
import { TokenPackageService } from '../wallet/token-package.service'
import { UpdateTokenPackageDto } from './dto/admin-token-package.dto'

/** The token package catalog as a super admin edits it; every change is audited with its author. */
@ApiTags('Admin')
@Controller('admin/token-packages')
@UseGuards(ApiAuthGuard)
@RequireSuperAdmin()
@RequireSessionUser()
export class AdminTokenPackageController {
  constructor(
    private readonly packages: TokenPackageService,
    private readonly auditService: AuditService,
  ) {}

  @Patch(':id')
  @ApiOperation({
    summary: 'Change price, tokens, bonus, label or visibility of a package (Admin)',
  })
  @ApiResponse({ status: 200, description: 'The package after the change' })
  @ApiResponse({
    status: 400,
    description: 'Price under USD 10, tokens not positive, negative bonus',
  })
  @ApiResponse({ status: 403, description: 'Not a super admin session (server token included)' })
  @ApiResponse({ status: 404, description: 'TOKEN_PACKAGE_NOT_FOUND' })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateTokenPackageDto,
    @Req() req: any,
  ) {
    const authorId: string = req.user.id
    const { before, after } = await this.packages.update(id, body)
    await this.auditService.log(
      authorId,
      'token_package_updated',
      'token_package',
      id,
      { before, after },
      `Token package ${after.slug} updated`,
    )
    return { data: after }
  }
}
