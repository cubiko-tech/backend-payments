import { Injectable } from '@nestjs/common'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource } from 'typeorm'
import {
  HealthCheckService,
  TypeOrmHealthIndicator,
  HealthCheckResult,
} from '@nestjs/terminus'

@Injectable()
export class HealthService {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    @InjectDataSource('DBWrite')
    private readonly dbWriteDataSource: DataSource,
    @InjectDataSource('DBRead')
    private readonly dbReadDataSource: DataSource,
  ) {}

  /**
   * Checks de salud para las conexiones a base de datos
   */
  private getDatabaseChecks() {
    return [
      () =>
        this.db.pingCheck('database-write', {
          connection: this.dbWriteDataSource,
          timeout: 3000,
        }),
      () =>
        this.db.pingCheck('database-read', {
          connection: this.dbReadDataSource,
          timeout: 3000,
        }),
    ]
  }

  /**
   * Check de liveness de la aplicación
   */
  private getAppLivenessCheck() {
    return async () => ({
      app: {
        status: 'up',
        message: 'Service is alive',
      },
    }) as any
  }

  /**
   * Liveness probe — la aplicación está corriendo
   */
  async checkLiveness(): Promise<HealthCheckResult> {
    return this.health.check([this.getAppLivenessCheck()])
  }

  /**
   * Readiness probe — la aplicación está lista para recibir tráfico
   */
  async checkReadiness(): Promise<HealthCheckResult> {
    return this.health.check(this.getDatabaseChecks())
  }

  /**
   * Health check completo (liveness + readiness)
   */
  async checkHealth(): Promise<HealthCheckResult> {
    return this.health.check([
      ...this.getDatabaseChecks(),
      this.getAppLivenessCheck(),
    ])
  }
}
