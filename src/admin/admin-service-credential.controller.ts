import { Body, Controller, Param, Patch, Post, Req, UseGuards } from '@nestjs/common'
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger'
import { EntityManager } from 'typeorm'
import { AuditService } from '../audit/audit.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireSessionUser, RequireSuperAdmin } from '../shared/auth/require-permission.decorator'
import {
  ServiceCredentialService,
  ServiceCredentialView,
} from '../shared/auth/service-credential.service'
import { ServiceClientDto, SetServiceCredentialActiveDto } from './dto/admin-service-credential.dto'

/**
 * Service credentials as a super admin issues, rotates and switches them. The key is in the answer
 * of the creation and the rotation only; the audit row commits with the change and never holds it.
 */
@ApiTags('Admin')
@Controller('admin/service-credentials')
@UseGuards(ApiAuthGuard)
@RequireSuperAdmin()
@RequireSessionUser()
export class AdminServiceCredentialController {
  constructor(
    private readonly credentials: ServiceCredentialService,
    private readonly auditService: AuditService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Issue the credential of a service; the key is shown once (Admin)' })
  @ApiResponse({ status: 201, description: 'The credential with its key' })
  @ApiResponse({ status: 400, description: 'Client not 3-50 lowercase letters, digits or dashes' })
  @ApiResponse({ status: 403, description: 'Not a super admin session (server token included)' })
  @ApiResponse({ status: 409, description: 'SERVICE_CREDENTIAL_EXISTS' })
  async create(@Body() body: ServiceClientDto, @Req() req: { user: { id: string } }) {
    const data = await this.credentials.create(body.client, this.audit(req, 'created'))
    return { data }
  }

  @Post(':client/rotate')
  @ApiOperation({ summary: 'Replace the key of a service; the previous one stops working (Admin)' })
  @ApiResponse({ status: 201, description: 'The credential with its new key' })
  @ApiResponse({ status: 404, description: 'SERVICE_CREDENTIAL_NOT_FOUND' })
  async rotate(@Param() params: ServiceClientDto, @Req() req: { user: { id: string } }) {
    const data = await this.credentials.rotate(params.client, this.audit(req, 'rotated'))
    return { data }
  }

  @Patch(':client')
  @ApiOperation({ summary: 'Turn the credential of a service on or off, keeping its key (Admin)' })
  @ApiResponse({ status: 200, description: 'The credential, without its key' })
  @ApiResponse({ status: 404, description: 'SERVICE_CREDENTIAL_NOT_FOUND' })
  async setActive(
    @Param() params: ServiceClientDto,
    @Body() body: SetServiceCredentialActiveDto,
    @Req() req: { user: { id: string } },
  ) {
    const action = body.active ? 'activated' : 'deactivated'
    const data = await this.credentials.setActive(
      params.client,
      body.active,
      this.audit(req, action),
    )
    return { data }
  }

  private audit(req: { user: { id: string } }, action: string) {
    const authorId: string = req.user.id
    return (manager: EntityManager, view: ServiceCredentialView) =>
      this.auditService.record(manager, {
        userId: authorId,
        action: `service_credential_${action}`,
        entityType: 'service_credential',
        entityId: view.id,
        changes: { client: view.client, active: view.active },
        description: `Service credential of ${view.client} ${action}`,
      })
  }
}
