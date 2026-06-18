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
  async processCheckout(@Body() body: CheckoutRequest) {
    return { data: await this.checkoutService.processCheckout(body) }
  }

  @Get('providers')
  @ApiOperation({ summary: 'Proveedores de pago disponibles para un país' })
  @ApiResponse({ status: 200, description: 'Lista de proveedores disponibles' })
  async getAvailableProviders(@Query('country') country: string) {
    const providers = await this.providerConfigService.getAvailableProviders(country || 'CO')
    return { data: providers }
  }
}
