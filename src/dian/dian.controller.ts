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

@ApiTags('DIAN')
@Controller('dian')
@UseGuards()
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
