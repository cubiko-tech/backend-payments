import { Controller, Get } from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { HealthService } from './health.service'

/**
 * Health Controller
 *
 * Endpoints PÚBLICOS (sin autenticación).
 * Usados por Kubernetes probes y load balancers.
 */
@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check completo' })
  @ApiResponse({ status: 200, description: 'Servicio saludable' })
  async health() {
    return this.healthService.checkHealth()
  }

  @Get('health/ready')
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiResponse({ status: 200, description: 'Servicio listo para recibir tráfico' })
  async readiness() {
    return this.healthService.checkReadiness()
  }

  @Get('health/live')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'Servicio está corriendo' })
  async liveness() {
    return this.healthService.checkLiveness()
  }
}
