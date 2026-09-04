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
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'

@ApiTags('Payment')
@Controller('payment')
/**
 * AUTENTICADO desde el 2026-08-29. Antes el decorador de guards de esta clase
 * venía SIN argumento: registra CERO guards, o sea que se leía como protegido y
 * no lo estaba. `ApiAuthGuard` **sólo autentica** —cookie, Bearer JWT o el
 * `ACCESS_SERVER` de servicio—; los permisos siguen siendo cosa de
 * `@RequirePermission` por handler, así que esto no le agrega requisitos a
 * ningún llamador que hoy pase. Ver `shared/auth/controllers-guarded.spec.ts`.
 */
@UseGuards(ApiAuthGuard)
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
