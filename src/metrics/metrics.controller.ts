import { Controller, Get, Query, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { MetricsService } from './metrics.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequireSuperAdmin } from '../shared/auth/require-permission.decorator'
import {
  MetricsDaysQueryDto,
  MetricsHistoryQueryDto,
  MetricsMonthsQueryDto,
} from './dto/metrics-query.dto'

@ApiTags('Admin Metrics')
@Controller('admin/metrics')
@UseGuards(ApiAuthGuard)
@RequireSuperAdmin()
@UsePipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }))
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
  async getRevenue(@Query() query: MetricsDaysQueryDto = {}) {
    return this.metricsService.getRevenue(query.days ?? 30)
  }

  @Get('churn')
  @ApiOperation({ summary: 'Tasa de cancelación/expiración por mes' })
  @ApiResponse({ status: 200, description: 'Churn rate mensual' })
  async getChurn(@Query() query: MetricsMonthsQueryDto = {}) {
    return this.metricsService.getChurn(query.months ?? 6)
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
  async getARPU(@Query() query: MetricsDaysQueryDto = {}) {
    return this.metricsService.getARPU(query.days ?? 30)
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
  async getRetention(@Query() query: MetricsMonthsQueryDto = {}) {
    return this.metricsService.getRetention(query.months ?? 6)
  }

  @Get('history')
  @ApiOperation({ summary: 'Snapshots históricos de métricas' })
  @ApiResponse({ status: 200, description: 'Snapshots diarios' })
  async getHistory(@Query() query: MetricsHistoryQueryDto = {}) {
    return this.metricsService.getSnapshots(query.type || 'daily_summary', query.days ?? 30)
  }
}
