import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { EntityManager, Repository } from 'typeorm'
import { AuditLog } from './entities/auditLog.entity'

/** One `audit_log` row: who did what to which entity, with the change it made. */
export interface AuditEntry {
  userId: string
  action: string
  entityType: string
  entityId: string
  changes?: Record<string, unknown>
  description?: string
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name)

  constructor(
    @InjectRepository(AuditLog, 'DBWrite')
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(AuditLog, 'DBRead')
    private readonly auditLogReadRepository: Repository<AuditLog>,
  ) {}

  /**
   * Registrar una entrada de auditoría.
   * Uso interno — no expone controller.
   */
  async log(
    userId: string,
    action: string,
    entityType: string,
    entityId: string,
    changes?: any,
    description?: string,
    ip?: string,
  ) {
    try {
      const entry = this.auditLogRepository.create({
        userId,
        action,
        entityType,
        entityId,
        changes,
        description,
        ip,
      })
      const saved = await this.auditLogRepository.save(entry)
      return { data: saved }
    } catch (error) {
      // No lanzar excepción para no interrumpir el flujo principal
      this.logger.error(
        `Error al registrar auditoría [${action}/${entityType}/${entityId}]: ${error.message}`,
      )
      return { error: error.message }
    }
  }

  /**
   * Writes the entry with the `manager` of the caller's transaction, so it commits or rolls back with
   * it. Unlike `log`, a failed write throws: the caller's transaction must not commit without it.
   */
  record(manager: EntityManager, entry: AuditEntry): Promise<AuditLog> {
    return manager.save(AuditLog, manager.create(AuditLog, entry))
  }

  /**
   * Buscar entradas de auditoría con filtros (sin paginación).
   */
  async find(filters: {
    entityType?: string
    entityId?: string
    action?: string
    userId?: string
    limit?: number
  }) {
    const where: any = {}
    if (filters.entityType) where.entityType = filters.entityType
    if (filters.entityId) where.entityId = filters.entityId
    if (filters.action) where.action = filters.action
    if (filters.userId) where.userId = filters.userId

    const entries = await this.auditLogReadRepository.find({
      where,
      order: { createdAt: 'DESC' },
      take: filters.limit || 50,
    })

    return { data: entries }
  }

  /**
   * Buscar entradas de auditoría con paginación server-side.
   */
  async findPaginated(filters: {
    entityType?: string
    action?: string
    userId?: string
    page?: number
    perPage?: number
  }) {
    const p = Math.max(1, filters.page || 1)
    const limit = Math.min(100, Math.max(1, filters.perPage || 20))
    const skip = (p - 1) * limit

    const where: any = {}
    if (filters.entityType) where.entityType = filters.entityType
    if (filters.action) where.action = filters.action
    if (filters.userId) where.userId = filters.userId

    const [data, total] = await this.auditLogReadRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip,
      take: limit,
    })

    return {
      data,
      count: total,
      meta: { page: p, perPage: limit, total, totalPages: Math.ceil(total / limit) },
    }
  }
}
