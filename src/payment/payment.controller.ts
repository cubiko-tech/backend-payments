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
import { PaymentService } from './payment.service'

@ApiTags('Payment')
@Controller('payment')
@UseGuards()
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('checkout')
  @ApiOperation({ summary: 'Crear un checkout de pago' })
  @ApiResponse({ status: 201, description: 'Checkout creado correctamente' })
  async createCheckout(@Body() data: any) {
    return this.paymentService.createCheckout(data)
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de un pago' })
  @ApiResponse({ status: 200, description: 'Pago obtenido correctamente' })
  async getPaymentById(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentService.getPaymentById(id)
  }

  @Get()
  @ApiOperation({ summary: 'Listar pagos de una marca' })
  @ApiResponse({ status: 200, description: 'Pagos obtenidos correctamente' })
  async getPaymentsByBrand(
    @Query('brandId') brandId: string,
    @Query() filters: { page?: number; limit?: number; status?: string },
  ) {
    return this.paymentService.getPaymentsByBrand(brandId, filters)
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancelar un pago pendiente' })
  @ApiResponse({ status: 200, description: 'Pago cancelado correctamente' })
  async cancelPayment(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentService.cancelPayment(id)
  }
}
