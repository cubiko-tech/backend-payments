import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { PaymentMethodService } from './payment-method.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'

@ApiTags('Payment Method')
@Controller('payment-method')
/**
 * AUTENTICADO desde el 2026-08-29. Antes el decorador de guards de esta clase
 * venía SIN argumento: registra CERO guards, o sea que se leía como protegido y
 * no lo estaba. `ApiAuthGuard` **sólo autentica** —cookie, Bearer JWT o el
 * `ACCESS_SERVER` de servicio—; los permisos siguen siendo cosa de
 * `@RequirePermission` por handler, así que esto no le agrega requisitos a
 * ningún llamador que hoy pase. Ver `shared/auth/controllers-guarded.spec.ts`.
 */
@UseGuards(ApiAuthGuard)
export class PaymentMethodController {
  constructor(private readonly paymentMethodService: PaymentMethodService) {}

  @Get()
  @ApiOperation({ summary: 'Listar métodos de pago de una marca' })
  @ApiResponse({ status: 200, description: 'Métodos de pago obtenidos correctamente' })
  async findByBrand(@Query('brandId') brandId: string) {
    return this.paymentMethodService.findByBrand(brandId)
  }

  @Post()
  @ApiOperation({ summary: 'Crear un método de pago' })
  @ApiResponse({ status: 201, description: 'Método de pago creado correctamente' })
  async create(@Body() data: any) {
    return this.paymentMethodService.create(data)
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar un método de pago' })
  @ApiResponse({ status: 200, description: 'Método de pago eliminado correctamente' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentMethodService.remove(id)
  }

  @Patch(':id/default')
  @ApiOperation({ summary: 'Establecer método de pago como predeterminado' })
  @ApiResponse({ status: 200, description: 'Método de pago establecido como predeterminado' })
  async setDefault(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentMethodService.setDefault(id)
  }
}
