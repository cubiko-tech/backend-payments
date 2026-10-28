import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
  ParseUUIDPipe,
  Logger,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { Response } from 'express'
import { InvoiceService } from './invoice.service'
import { InvoicePdfService } from './invoice-pdf.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { ClientPlatformService } from '../client/client-platform.service'
import {
  assertBrandAccess,
  assertResourceBrandAccess,
  isPrivilegedCaller,
} from '../shared/auth/brand-scope.util'

@ApiTags('Invoice')
@Controller('invoice')
/**
 * AUTENTICADO desde el 2026-08-29. Antes el decorador de guards de esta clase
 * venía SIN argumento: registra CERO guards, o sea que se leía como protegido y
 * no lo estaba. `ApiAuthGuard` **sólo autentica** —cookie, Bearer JWT o el
 * `ACCESS_SERVER` de servicio—; los permisos siguen siendo cosa de
 * `@RequirePermission` por handler, así que esto no le agrega requisitos a
 * ningún llamador que hoy pase. Ver `shared/auth/controllers-guarded.spec.ts`.
 */
@UseGuards(ApiAuthGuard)
export class InvoiceController {
  private readonly logger = new Logger(InvoiceController.name)

  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly invoicePdfService: InvoicePdfService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar facturas de una marca' })
  @ApiResponse({ status: 200, description: 'Facturas obtenidas correctamente' })
  async findByBrand(
    @Query('brandId') brandId: string,
    @Query() filters: { page?: number; limit?: number; type?: string },
    @Req() req?: any,
  ) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      brandId,
      'GET /invoice',
    )
    return this.invoiceService.findByBrand(validBrandId, filters)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de una factura' })
  @ApiResponse({ status: 200, description: 'Factura obtenida correctamente' })
  async findById(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    const result = await this.invoiceService.findById(id)
    await assertResourceBrandAccess(
      this.platformClient,
      this.logger,
      req,
      result?.data?.brandId,
      'GET /invoice/:id',
    )
    return result
  }

  @Get(':id/pdf')
  @ApiOperation({ summary: 'Descargar factura en PDF' })
  @ApiResponse({ status: 200, description: 'PDF de factura' })
  async downloadPdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
    @Req() req?: any,
  ) {
    if (!isPrivilegedCaller(req)) {
      const invoice = await this.invoiceService.findById(id)
      await assertResourceBrandAccess(
        this.platformClient,
        this.logger,
        req,
        invoice?.data?.brandId,
        'GET /invoice/:id/pdf',
      )
    }

    const pdfBuffer = await this.invoicePdfService.generatePdf(id)

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="factura-${id}.pdf"`,
      'Content-Length': pdfBuffer.length,
    })

    res.end(pdfBuffer)
  }

  @Get(':id/credit-notes')
  @ApiOperation({ summary: 'Obtener notas crédito de una factura' })
  @ApiResponse({ status: 200, description: 'Notas crédito obtenidas correctamente' })
  async getCreditNotes(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    if (!isPrivilegedCaller(req)) {
      const invoice = await this.invoiceService.findById(id)
      await assertResourceBrandAccess(
        this.platformClient,
        this.logger,
        req,
        invoice?.data?.brandId,
        'GET /invoice/:id/credit-notes',
      )
    }
    return this.invoiceService.findCreditNotes(id)
  }
}
