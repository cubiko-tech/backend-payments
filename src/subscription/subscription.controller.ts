import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { SubscriptionService } from './subscription.service'
import { EnterprisePricingService } from './enterprise-pricing.service'

@ApiTags('Subscription')
@Controller('subscription')
@UseGuards()
export class SubscriptionController {
  constructor(
    private readonly subscriptionService: SubscriptionService,
    private readonly enterprisePricingService: EnterprisePricingService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Obtener suscripción actual de una marca' })
  @ApiResponse({ status: 200, description: 'Suscripción obtenida correctamente' })
  async getCurrent(@Query('brandId') brandId: string) {
    return this.subscriptionService.getCurrent(brandId)
  }

  @Post()
  @ApiOperation({ summary: 'Crear una suscripción' })
  @ApiResponse({ status: 201, description: 'Suscripción creada correctamente' })
  async create(@Body() data: any) {
    return this.subscriptionService.create(data)
  }

  @Patch('plan')
  @ApiOperation({ summary: 'Cambiar de plan' })
  @ApiResponse({ status: 200, description: 'Plan cambiado correctamente' })
  async changePlan(@Body() data: { brandId: string; planSlug: string; triggeredBy: string }) {
    return this.subscriptionService.changePlan(data.brandId, {
      planSlug: data.planSlug,
      triggeredBy: data.triggeredBy,
    })
  }

  @Post('cancel')
  @ApiOperation({ summary: 'Cancelar suscripción' })
  @ApiResponse({ status: 200, description: 'Suscripción cancelada correctamente' })
  async cancel(@Body() data: { brandId: string; reason: string; triggeredBy: string }) {
    return this.subscriptionService.cancel(data.brandId, {
      reason: data.reason,
      triggeredBy: data.triggeredBy,
    })
  }

  @Post('reactivate')
  @ApiOperation({ summary: 'Reactivar suscripción cancelada' })
  @ApiResponse({ status: 200, description: 'Suscripción reactivada correctamente' })
  async reactivate(@Body() data: { brandId: string; triggeredBy: string }) {
    return this.subscriptionService.reactivate(data.brandId, data.triggeredBy)
  }

  @Get('history')
  @ApiOperation({ summary: 'Historial de eventos de suscripción' })
  @ApiResponse({ status: 200, description: 'Historial obtenido correctamente' })
  async getHistory(@Query('brandId') brandId: string) {
    return this.subscriptionService.getHistory(brandId)
  }

  // ============================================
  // Enterprise Pricing (Admin)
  // ============================================

  @Get('enterprise-pricing')
  @ApiOperation({ summary: 'Listar precios enterprise personalizados (Admin)' })
  @ApiResponse({ status: 200, description: 'Lista de precios enterprise' })
  async listEnterprisePricing() {
    return this.enterprisePricingService.findAll()
  }

  @Get('enterprise-pricing/:brandId')
  @ApiOperation({ summary: 'Obtener precio enterprise de una marca (Admin)' })
  @ApiResponse({ status: 200, description: 'Precio enterprise obtenido' })
  async getEnterprisePricing(@Param('brandId') brandId: string) {
    const pricing = await this.enterprisePricingService.getForBrand(brandId)
    return { data: pricing }
  }

  @Post('enterprise-pricing/:brandId')
  @ApiOperation({ summary: 'Crear/actualizar precio enterprise para marca (Admin)' })
  @ApiResponse({ status: 201, description: 'Precio enterprise guardado' })
  async upsertEnterprisePricing(
    @Param('brandId') brandId: string,
    @Body() data: {
      monthlyPrice: number
      currency?: string
      negotiatedBy?: string
      validUntil?: string
      notes?: string
    },
  ) {
    return this.enterprisePricingService.upsert(brandId, {
      ...data,
      validUntil: data.validUntil ? new Date(data.validUntil) : undefined,
    })
  }

  @Delete('enterprise-pricing/:brandId')
  @ApiOperation({ summary: 'Eliminar precio enterprise (volver a estándar) (Admin)' })
  @ApiResponse({ status: 200, description: 'Precio enterprise eliminado' })
  async removeEnterprisePricing(@Param('brandId') brandId: string) {
    return this.enterprisePricingService.remove(brandId)
  }
}
