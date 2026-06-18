import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { RefundService } from './refund.service'

@ApiTags('Refund')
@Controller('refund')
@UseGuards()
export class RefundController {
  constructor(private readonly refundService: RefundService) {}

  @Post()
  @ApiOperation({ summary: 'Solicitar un reembolso' })
  @ApiResponse({ status: 201, description: 'Reembolso solicitado correctamente' })
  async request(@Body() data: any) {
    return this.refundService.request(data)
  }

  @Get()
  @ApiOperation({ summary: 'Listar reembolsos de una marca' })
  @ApiResponse({ status: 200, description: 'Reembolsos obtenidos correctamente' })
  async findByBrand(
    @Query('brandId') brandId: string,
    @Query() filters: { page?: number; limit?: number; status?: string },
  ) {
    return this.refundService.findByBrand(brandId, filters)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de un reembolso' })
  @ApiResponse({ status: 200, description: 'Reembolso obtenido correctamente' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.refundService.findById(id)
  }

  @Post(':id/approve')
  @ApiOperation({ summary: 'Aprobar un reembolso pendiente' })
  @ApiResponse({ status: 200, description: 'Reembolso aprobado correctamente' })
  async approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() data: { approvedBy: string },
  ) {
    return this.refundService.approve(id, data.approvedBy)
  }
}
