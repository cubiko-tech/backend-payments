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
import { PaymentService } from './payment.service'
import { CreatePaymentCheckoutDto } from './dto/create-payment-checkout.dto'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { ClientPlatformService } from '../client/client-platform.service'
import {
  assertBrandAccess,
  assertResourceBrandAccess,
  isPrivilegedCaller,
  resolveRequestBrandId,
} from '../shared/auth/brand-scope.util'

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
  private readonly logger = new Logger(PaymentController.name)

  constructor(
    private readonly paymentService: PaymentService,
    private readonly platformClient: ClientPlatformService,
  ) {}

  @Post('checkout')
  @ApiOperation({ summary: 'Crear un checkout de pago' })
  @ApiResponse({ status: 201, description: 'Checkout creado correctamente' })
  async createCheckout(
    @Body() data: CreatePaymentCheckoutDto,
    @Req() req?: any,
    @Query('brandId') brandId?: string,
  ) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      resolveRequestBrandId(req, brandId),
      'POST /payment/checkout',
    )
    return this.paymentService.createCheckout({ ...data, brandId: validBrandId })
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtener detalle de un pago' })
  @ApiResponse({ status: 200, description: 'Pago obtenido correctamente' })
  async getPaymentById(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    const result = await this.paymentService.getPaymentById(id)
    await assertResourceBrandAccess(
      this.platformClient,
      this.logger,
      req,
      result?.data?.brandId,
      'GET /payment/:id',
    )
    return result
  }

  @Get()
  @ApiOperation({ summary: 'Listar pagos de una marca' })
  @ApiResponse({ status: 200, description: 'Pagos obtenidos correctamente' })
  async getPaymentsByBrand(
    @Query('brandId') brandId: string,
    @Query() filters: { page?: number; limit?: number; status?: string },
    @Req() req?: any,
  ) {
    const validBrandId = await assertBrandAccess(
      this.platformClient,
      this.logger,
      req,
      brandId,
      'GET /payment',
    )
    return this.paymentService.getPaymentsByBrand(validBrandId, filters)
  }

  @Post(':id/cancel')
  @ApiOperation({ summary: 'Cancelar un pago pendiente' })
  @ApiResponse({ status: 200, description: 'Pago cancelado correctamente' })
  async cancelPayment(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    if (!isPrivilegedCaller(req)) {
      const payment = await this.paymentService.getPaymentById(id)
      await assertResourceBrandAccess(
        this.platformClient,
        this.logger,
        req,
        payment?.data?.brandId,
        'POST /payment/:id/cancel',
      )
    }
    return this.paymentService.cancelPayment(id)
  }
}
