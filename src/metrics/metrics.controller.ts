import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { MetricsService } from './metrics.service'

@ApiTags('Admin Metrics')
@Controller('admin/metrics')
@UseGuards()
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Get('mrr')
  @ApiOperation({ summary: 'Monthly Recurring Revenue actual' })
  @ApiResponse({ status: 200, description: 'MRR por plan' })
  async getMRR() {
    return this.metricsService.getMRR()
  }

  @Get('revenue')
  @ApiOperation({ summary: 'Ingresos por período' })
  @ApiResponse({ status: 200, description: 'Revenue breakdown por día, proveedor y propósito' })
  async getRevenue(@Query('days') days?: number) {
    return this.metricsService.getRevenue(days || 30)
  }

  @Get('churn')
  @ApiOperation({ summary: 'Tasa de cancelación/expiración por mes' })
  @ApiResponse({ status: 200, description: 'Churn rate mensual' })
  async getChurn(@Query('months') months?: number) {
    return this.metricsService.getChurn(months || 6)
  }

  @Get('ltv')
  @ApiOperation({ summary: 'Valor promedio de vida del cliente por plan' })
  @ApiResponse({ status: 200, description: 'LTV por plan' })
  async getLTV() {
    return this.metricsService.getLTV()
  }

  @Get('arpu')
  @ApiOperation({ summary: 'Average Revenue Per User' })
  @ApiResponse({ status: 200, description: 'ARPU del período' })
  async getARPU(@Query('days') days?: number) {
    return this.metricsService.getARPU(days || 30)
  }

  @Get('conversion')
  @ApiOperation({ summary: 'Tasa de conversión free→paid y cambios de plan' })
  @ApiResponse({ status: 200, description: 'Datos de conversión' })
  async getConversion() {
    return this.metricsService.getConversion()
  }

  @Get('payment-methods')
  @ApiOperation({ summary: 'Distribución por método de pago (últimos 90 días)' })
  @ApiResponse({ status: 200, description: 'Distribución por proveedor' })
  async getPaymentMethods() {
    return this.metricsService.getPaymentMethods()
  }

  @Get('retention')
  @ApiOperation({ summary: 'Retención por cohorte mensual' })
  @ApiResponse({ status: 200, description: 'Datos de retención por cohorte' })
  async getRetention(@Query('months') months?: number) {
    return this.metricsService.getRetention(months || 6)
  }

  @Get('history')
  @ApiOperation({ summary: 'Snapshots históricos de métricas' })
  @ApiResponse({ status: 200, description: 'Snapshots diarios' })
  async getHistory(
    @Query('type') type?: string,
    @Query('days') days?: number,
  ) {
    return this.metricsService.getSnapshots(type || 'daily_summary', days || 30)
  }
}
