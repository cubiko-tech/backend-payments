import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ParseUUIDPipe,
  Logger,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { PaymentMethodService } from './payment-method.service'
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { ClientPlatformService } from '../client/client-platform.service'
import {
  assertBrandAccess,
  assertResourceBrandAccess,
  isPrivilegedCaller,
  resolveRequestBrandId,
} from '../shared/auth/brand-scope.util'

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
  private readonly logger = new Logger(PaymentMethodController.name)

  constructor(
    private readonly paymentMethodService: PaymentMethodService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Listar métodos de pago de una marca' })
  @ApiResponse({ status: 200, description: 'Métodos de pago obtenidos correctamente' })
  async findByBrand(@Query('brandId') brandId: string, @Req() req?: any) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      brandId,
      'GET /payment-method',
    )
    return this.paymentMethodService.findByBrand(validBrandId)
  }

  @Post()
  @ApiOperation({ summary: 'Crear un método de pago' })
  @ApiResponse({ status: 201, description: 'Método de pago creado correctamente' })
  async create(
    @Body() data: CreatePaymentMethodDto,
    @Req() req?: any,
    @Query('brandId') brandId?: string,
  ) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      resolveRequestBrandId(req, brandId),
      'POST /payment-method',
    )
    return this.paymentMethodService.create({ ...data, brandId: validBrandId })
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Eliminar un método de pago' })
  @ApiResponse({ status: 200, description: 'Método de pago eliminado correctamente' })
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    if (!isPrivilegedCaller(req)) {
      const method = await this.paymentMethodService.findById(id)
      await assertResourceBrandAccess(
        this.platformClient,
        this.logger,
        req,
        method?.data?.brandId,
        'DELETE /payment-method/:id',
      )
    }
    return this.paymentMethodService.remove(id)
  }

  @Patch(':id/default')
  @ApiOperation({ summary: 'Establecer método de pago como predeterminado' })
  @ApiResponse({ status: 200, description: 'Método de pago establecido como predeterminado' })
  async setDefault(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    if (!isPrivilegedCaller(req)) {
      const method = await this.paymentMethodService.findById(id)
      await assertResourceBrandAccess(
        this.platformClient,
        this.logger,
        req,
        method?.data?.brandId,
        'PATCH /payment-method/:id/default',
      )
    }
    return this.paymentMethodService.setDefault(id)
  }
}
