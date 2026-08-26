import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { CheckoutService, CheckoutRequest } from './checkout.service'
import { ProviderConfigService } from '../provider/provider-config.service'

@ApiTags('Checkout')
@Controller('checkout')
@UseGuards()
export class CheckoutController {
  constructor(
    private readonly checkoutService: CheckoutService,
    private readonly providerConfigService: ProviderConfigService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Procesar checkout completo (pago → suscripción → factura → DIAN → roles)' })
  @ApiResponse({ status: 201, description: 'Checkout procesado' })
  @ApiResponse({
    status: 400,
    description: 'INVALID_BRAND_ID (brandId ausente o que no es un UUID), INVALID_PLAN_SLUG '
      + 'o MISSING_WALLET_ID (pago con wallet sin walletId)',
  })
  @ApiResponse({
    status: 404,
    description: 'BRAND_NOT_FOUND (platform no conoce la marca) o WALLET_NOT_FOUND '
      + '(la wallet no existe o no es de esa marca)',
  })
  @ApiResponse({
    status: 422,
    description: 'BRAND_WITHOUT_COUNTRY, PRICE_NOT_FOUND_FOR_COUNTRY o '
      + 'WALLET_CURRENCY_MISMATCH: no se puede determinar o cobrar el precio',
  })
  @ApiResponse({
    status: 503,
    description: 'BRAND_LOOKUP_UNAVAILABLE o PLAN_NOT_FOUND: platform o backend-roles no responden',
  })
  async processCheckout(@Body() body: CheckoutRequest) {
    // `renewal` es service-to-service (sólo el cron). `CheckoutRequest` es una
    // interfaz, así que el `ValidationPipe({ whitelist, forbidNonWhitelisted })`
    // global no tiene metatype contra el cual recortar y NO descarta claves
    // desconocidas: sin este borrado un llamador HTTP podría pedir el camino de
    // precios legacy y cobrarse en la moneda que él mande.
    return { data: await this.checkoutService.processCheckout({ ...body, renewal: undefined }) }
  }

  @Get('providers')
  @ApiOperation({ summary: 'Proveedores de pago disponibles para un país' })
  @ApiResponse({ status: 200, description: 'Lista de proveedores disponibles' })
  async getAvailableProviders(@Query('country') country: string) {
    const providers = await this.providerConfigService.getAvailableProviders(country || 'CO')
    return { data: providers }
  }

  @Get('return')
  @ApiOperation({ summary: 'Reconciliar un pago al volver del checkout (consulta estado real del proveedor)' })
  @ApiResponse({ status: 200, description: 'Estado reconciliado del pago' })
  async paymentReturn(
    @Query('paymentId') paymentId?: string,
    @Query('correlation_id') correlationId?: string,
  ) {
    // ConfioPagos redirige con correlation_id = nuestro paymentId.
    return { data: await this.checkoutService.reconcilePayment(paymentId || correlationId) }
  }
}
