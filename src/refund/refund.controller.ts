import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
  Logger,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { RefundService } from './refund.service'
import { RequestRefundDto } from './dto/request-refund.dto'
import { ApproveRefundDto } from './dto/approve-refund.dto'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { ClientPlatformService } from '../client/client-platform.service'
import {
  assertBrandAccess,
  assertResourceBrandAccess,
  isPrivilegedCaller,
  resolveRequestBrandId,
} from '../shared/auth/brand-scope.util'

@ApiTags('Refund')
@Controller('refund')
/**
 * AUTENTICADO desde el 2026-08-29. Antes el decorador de guards de esta clase
 * venía SIN argumento: registra CERO guards, o sea que se leía como protegido y
 * no lo estaba. `ApiAuthGuard` **sólo autentica** —cookie, Bearer JWT o el
 * `ACCESS_SERVER` de servicio—; los permisos siguen siendo cosa de
 * `@RequirePermission` por handler, así que esto no le agrega requisitos a
 * ningún llamador que hoy pase. Ver `shared/auth/controllers-guarded.spec.ts`.
 */
@UseGuards(ApiAuthGuard)
export class RefundController {
  private readonly logger = new Logger(RefundController.name)

  constructor(
    private readonly refundService: RefundService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Solicitar un reembolso' })
  @ApiResponse({ status: 201, description: 'Reembolso solicitado correctamente' })
  async request(
    @Body() data: RequestRefundDto,
    @Req() req?: any,
    @Query('brandId') brandId?: string,
  ) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      resolveRequestBrandId(req, brandId),
      'POST /refund',
    )
    return this.refundService.request({ ...data, brandId: validBrandId })
  }

  @Get()
  @ApiOperation({ summary: 'Listar reembolsos de una marca' })
  @ApiResponse({ status: 200, description: 'Reembolsos obtenidos correctamente' })
  async findByBrand(
    @Query('brandId') brandId: string,
    @Query() filters: { page?: number; limit?: number; status?: string },
    @Req() req?: any,
  ) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      brandId,
      'GET /refund',
    )
    return this.refundService.findByBrand(validBrandId, filters)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de un reembolso' })
  @ApiResponse({ status: 200, description: 'Reembolso obtenido correctamente' })
  async findById(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    const result = await this.refundService.findById(id)
    await assertResourceBrandAccess(
      this.platformClient,
      this.logger,
      req,
      result?.data?.brandId,
      'GET /refund/:id',
    )
    return result
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Aprobar un reembolso pendiente' })
  @ApiResponse({ status: 200, description: 'Reembolso aprobado correctamente' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: ApproveRefundDto,
    @Req() req?: any,
  ) {
    if (!isPrivilegedCaller(req)) {
      const refund = await this.refundService.findById(id)
      await assertResourceBrandAccess(
        this.platformClient,
        this.logger,
        req,
        refund?.data?.brandId,
        'POST /refund/:id/approve',
      )
    }
    return this.refundService.approve(id, data.approvedBy)
  }
}
