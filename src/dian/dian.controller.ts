import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { DianService } from './dian.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'

@ApiTags('DIAN')
@Controller('dian')
/**
 * AUTENTICADO desde el 2026-08-29. Antes el decorador de guards de esta clase
 * venía SIN argumento: registra CERO guards, o sea que se leía como protegido y
 * no lo estaba. `ApiAuthGuard` **sólo autentica** —cookie, Bearer JWT o el
 * `ACCESS_SERVER` de servicio—; los permisos siguen siendo cosa de
 * `@RequirePermission` por handler, así que esto no le agrega requisitos a
 * ningún llamador que hoy pase. Ver `shared/auth/controllers-guarded.spec.ts`.
 */
@UseGuards(ApiAuthGuard)
export class DianController {
  constructor(private readonly dianService: DianService) {}

  @Post('send/:invoiceId')
  @ApiOperation({ summary: 'Enviar factura a la DIAN' })
  @ApiResponse({ status: 200, description: 'Resultado del envío a DIAN' })
  async sendInvoice(@Param('invoiceId', ParseUUIDPipe) invoiceId: string) {
    return this.dianService.sendInvoice(invoiceId)
  }

  @Get('status/:invoiceId')
  @ApiOperation({ summary: 'Consultar estado de factura ante la DIAN' })
  @ApiResponse({ status: 200, description: 'Estado del documento' })
  async checkStatus(@Param('invoiceId', ParseUUIDPipe) invoiceId: string) {
    return this.dianService.checkStatus(invoiceId)
  }

  @Get('configured')
  @ApiOperation({ summary: 'Verificar si DIAN está configurado' })
  @ApiResponse({ status: 200, description: 'Estado de configuración' })
  async isConfigured() {
    return { data: { configured: this.dianService.isConfigured() } }
  }
}
