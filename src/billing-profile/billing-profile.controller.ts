import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { BillingProfileService } from './billing-profile.service'
import { LegalDocumentService } from './legal-document.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'

@ApiTags('Billing Profile')
@Controller('billing-profile')
/**
 * AUTENTICADO desde el 2026-08-29. Antes el decorador de guards de esta clase
 * venía SIN argumento: registra CERO guards, o sea que se leía como protegido y
 * no lo estaba. `ApiAuthGuard` **sólo autentica** —cookie, Bearer JWT o el
 * `ACCESS_SERVER` de servicio—; los permisos siguen siendo cosa de
 * `@RequirePermission` por handler, así que esto no le agrega requisitos a
 * ningún llamador que hoy pase. Ver `shared/auth/controllers-guarded.spec.ts`.
 */
@UseGuards(ApiAuthGuard)
export class BillingProfileController {
  constructor(
    private readonly billingProfileService: BillingProfileService,
    private readonly legalDocumentService: LegalDocumentService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Obtener perfil de facturación de una marca' })
  @ApiResponse({ status: 200, description: 'Perfil de facturación obtenido correctamente' })
  async get(@Query('brandId') brandId: string) {
    return this.billingProfileService.get(brandId)
  }

  @Post()
  @ApiOperation({ summary: 'Crear perfil de facturación (valida según país)' })
  @ApiResponse({ status: 201, description: 'Perfil de facturación creado correctamente' })
  async create(@Body() data: any) {
    return this.billingProfileService.create(data)
  }

  @Patch()
  @ApiOperation({ summary: 'Actualizar perfil de facturación (valida según país)' })
  @ApiResponse({ status: 200, description: 'Perfil de facturación actualizado correctamente' })
  async update(@Query('brandId') brandId: string, @Body() data: any) {
    return this.billingProfileService.update(brandId, data)
  }

  @Get('requirements')
  @ApiOperation({ summary: 'Requisitos de facturación por país (campos, documentos, impuestos)' })
  @ApiResponse({ status: 200, description: 'Requisitos obtenidos' })
  async getRequirements(@Query('country') country: string) {
    return this.billingProfileService.getRequirements(country || 'CO')
  }

  // ============================================
  // Documentos legales
  // ============================================

  @Get(':brandId/documents')
  @ApiOperation({ summary: 'Listar documentos legales de una marca' })
  @ApiResponse({ status: 200, description: 'Documentos obtenidos' })
  async getDocuments(@Param('brandId') brandId: string) {
    return this.legalDocumentService.findByBrand(brandId)
  }

  @Post(':brandId/documents')
  @ApiOperation({ summary: 'Subir documento legal de una marca' })
  @ApiResponse({ status: 201, description: 'Documento subido' })
  async uploadDocument(
    @Param('brandId') brandId: string,
    @Body() data: { country: string; documentType: string; documentUrl: string },
  ) {
    return this.legalDocumentService.upsert({ brandId, ...data })
  }

  // Admin: verificar/rechazar documentos

  @Get('admin/documents')
  @ApiOperation({ summary: 'Listar todos los documentos legales paginados con filtros (Admin)' })
  @ApiResponse({ status: 200, description: 'Documentos legales' })
  async getAllDocuments(
    @Query('status') status?: string,
    @Query('country') country?: string,
    @Query('documentType') documentType?: string,
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
  ) {
    return this.legalDocumentService.findAll({
      status, country, documentType,
      page: Number(page) || 1,
      perPage: Number(perPage) || 20,
    })
  }

  @Get('admin/documents/pending')
  @ApiOperation({ summary: 'Listar documentos pendientes de verificación (Admin)' })
  @ApiResponse({ status: 200, description: 'Documentos pendientes' })
  async getPendingDocuments(@Query('limit') limit?: number) {
    return this.legalDocumentService.findPending(limit || 50)
  }

  @Post('admin/documents/:id/verify')
  @ApiOperation({ summary: 'Verificar documento legal (Admin)' })
  @ApiResponse({ status: 200, description: 'Documento verificado' })
  async verifyDocument(
    @Param('id') id: string,
    @Body() data: { verifiedBy: string },
  ) {
    return this.legalDocumentService.verify(id, data.verifiedBy)
  }

  @Post('admin/documents/:id/reject')
  @ApiOperation({ summary: 'Rechazar documento legal (Admin)' })
  @ApiResponse({ status: 200, description: 'Documento rechazado' })
  async rejectDocument(
    @Param('id') id: string,
    @Body() data: { verifiedBy: string; reason: string },
  ) {
    return this.legalDocumentService.reject(id, data.verifiedBy, data.reason)
  }
}
