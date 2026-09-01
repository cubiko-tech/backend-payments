import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'
import { MetricsSnapshot } from './entities/metricsSnapshot.entity'
import { Subscription } from '../subscription/entities/subscription.entity'
import { Payment } from '../payment/entities/payment.entity'
import { ClientRolesService } from '../client/client-roles.service'

@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name)

  constructor(
    @InjectRepository(MetricsSnapshot, 'DBWrite')
    private readonly snapshotRepo: Repository<MetricsSnapshot>,
    @InjectRepository(MetricsSnapshot, 'DBRead')
    private readonly snapshotReadRepo: Repository<MetricsSnapshot>,
    @InjectDataSource('DBRead')
    private readonly readDataSource: DataSource,
    private readonly clientRoles: ClientRolesService,
  ) {}

  // =============================================================
  // Métricas en tiempo real (queries a BD)
  // =============================================================

  /**
   * MRR — Monthly Recurring Revenue actual.
   */
  async getMRR() {
    // Contar suscriptores activos por plan
    const subscribers = await this.readDataSource.query(`
      SELECT
        s."planSlug",
        COUNT(*) as subscribers
      FROM subscriptions s
      WHERE s.status IN ('active', 'trial')
      GROUP BY s."planSlug"
      ORDER BY subscribers DESC
    `)

    // Obtener precios desde backend-roles (caché)
    const prices = await this.clientRoles.getAllPlanPrices()

    const byPlan = subscribers.map((row: any) => {
      const planPrices = prices.get(row.planSlug)
      const price = planPrices?.get('COP') || 0
      return {
        planSlug: row.planSlug,
        subscribers: Number(row.subscribers),
        pricePerMonth: price,
        mrr: Number(row.subscribers) * price,
      }
    })

    const total = byPlan.reduce((sum: number, r: any) => sum + r.mrr, 0)

    return { data: { total: Math.round(total * 100) / 100, byPlan } }
  }

  /**
   * Ingresos por período.
   */
  async getRevenue(days = 30) {
    const result = await this.readDataSource.query(`
      SELECT
        DATE_TRUNC('day', "paidAt") as date,
        p.provider,
        p.purpose,
        COUNT(*) as count,
        SUM(p.amount) as total
      FROM payments p
      WHERE p.status = 'completed'
        AND p."paidAt" >= NOW() - INTERVAL '${days} days'
      GROUP BY date, p.provider, p.purpose
      ORDER BY date DESC
    `)

    const totalRevenue = result.reduce((sum: number, r: any) => sum + Number(r.total || 0), 0)

    return { data: { days, totalRevenue: Math.round(totalRevenue * 100) / 100, breakdown: result } }
  }

  /**
   * Churn rate — tasa de cancelación/expiración por mes.
   */
  async getChurn(months = 6) {
    const result = await this.readDataSource.query(`
      SELECT
        DATE_TRUNC('month', se."createdAt") as month,
        COUNT(*) FILTER (WHERE se."eventType" IN ('cancelled', 'expired')) as churned,
        COUNT(*) FILTER (WHERE se."eventType" = 'created') as new_subs
      FROM subscription_events se
      WHERE se."createdAt" >= NOW() - INTERVAL '${months} months'
      GROUP BY month
      ORDER BY month DESC
    `)

    return { data: { months, monthly: result } }
  }

  /**
   * LTV — Valor promedio de vida del cliente por plan.
   *
   * El criterio de qué fila es un CLIENTE es la lista CERRADA del `WHERE`, y no el
   * `status != 'trial'` que estaba: un filtro negativo absorbe solo cada estado nuevo,
   * y `pending` —el alta paga que todavía no pagó su primer ciclo— entraba como
   * cliente. Su antigüedad se mide desde `createdAt`, así que cada alta abandonada
   * sumaba días de «vida útil» que nadie pagó y arrastraba el promedio del plan.
   * `trial` sigue afuera por lo mismo, y ahora está dicho enumerando. Mismo criterio
   * que `getConversion`/`getMRR`, que cuentan marcas pagas; lo fija
   * `metrics.service.spec.ts`.
   */
  async getLTV() {
    const result = await this.readDataSource.query(`
      SELECT
        s."planSlug",
        COUNT(*) as total_subscriptions,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (COALESCE(s."cancelledAt", NOW()) - s."createdAt")) / 86400
        )) as avg_days_active,
        ROUND(AVG(
          EXTRACT(EPOCH FROM (COALESCE(s."cancelledAt", NOW()) - s."createdAt")) / 86400 / 30
        ), 1) as avg_months_active
      FROM subscriptions s
      WHERE s.status IN ('active', 'past_due', 'cancelled', 'expired')
      GROUP BY s."planSlug"
      ORDER BY avg_days_active DESC
    `)

    return { data: result }
  }

  /**
   * ARPU — Average Revenue Per User.
   */
  async getARPU(days = 30) {
    const result = await this.readDataSource.query(`
      SELECT
        COUNT(DISTINCT p."brandId") as paying_brands,
        SUM(p.amount) as total_revenue,
        CASE
          WHEN COUNT(DISTINCT p."brandId") > 0
          THEN ROUND(SUM(p.amount) / COUNT(DISTINCT p."brandId"), 2)
          ELSE 0
        END as arpu
      FROM payments p
      WHERE p.status = 'completed'
        AND p."paidAt" >= NOW() - INTERVAL '${days} days'
    `)

    return { data: { days, ...result[0] } }
  }

  /**
   * Conversión free → paid.
   */
  async getConversion() {
    const result = await this.readDataSource.query(`
      SELECT
        se."fromPlanSlug",
        se."toPlanSlug",
        COUNT(*) as count,
        DATE_TRUNC('month', se."createdAt") as month
      FROM subscription_events se
      WHERE se."eventType" = 'plan_changed'
        AND se."createdAt" >= NOW() - INTERVAL '6 months'
      GROUP BY se."fromPlanSlug", se."toPlanSlug", month
      ORDER BY month DESC, count DESC
    `)

    // Calcular tasa free→paid
    const freeCount = await this.readDataSource.query(`
      SELECT COUNT(*) as count FROM subscriptions WHERE "planSlug" = 'free'
    `)
    // El criterio de «marca paga» es esta lista CERRADA de estados, y `pending` no
    // está: es un alta que todavía no pagó su primer ciclo. Contarla inflaría la
    // conversión free→paid con altas abandonadas —el que abrió el link y nunca lo
    // aceptó figuraría como convertido— y la métrica dejaría de medir plata cobrada.
    // `getMRR` usa el MISMO criterio para contar suscriptores, así que tampoco lo
    // cuenta: si algún día este conjunto cambia, los dos tienen que cambiar juntos.
    // Lo fija el caso de `metrics.service.spec.ts` sobre este SQL.
    const paidCount = await this.readDataSource.query(`
      SELECT COUNT(*) as count FROM subscriptions WHERE "planSlug" != 'free' AND status IN ('active', 'trial')
    `)

    return {
      data: {
        freeUsers: Number(freeCount[0]?.count || 0),
        paidUsers: Number(paidCount[0]?.count || 0),
        planChanges: result,
      },
    }
  }

  /**
   * Distribución por método de pago.
   */
  async getPaymentMethods() {
    const result = await this.readDataSource.query(`
      SELECT
        p.provider,
        COUNT(*) as count,
        SUM(p.amount) as total
      FROM payments p
      WHERE p.status = 'completed'
        AND p."paidAt" >= NOW() - INTERVAL '90 days'
      GROUP BY p.provider
      ORDER BY count DESC
    `)

    return { data: result }
  }

  /**
   * Retención por cohorte mensual.
   */
  async getRetention(months = 6) {
    const result = await this.readDataSource.query(`
      WITH cohorts AS (
        SELECT
          "brandId",
          DATE_TRUNC('month', "createdAt") as cohort_month
        FROM subscriptions
        WHERE "createdAt" >= NOW() - INTERVAL '${months} months'
      ),
      activity AS (
        SELECT
          s."brandId",
          DATE_TRUNC('month', se."createdAt") as activity_month
        FROM subscription_events se
        JOIN subscriptions s ON s.id = se."subscriptionId"
        WHERE se."eventType" NOT IN ('cancelled', 'expired')
          AND se."createdAt" >= NOW() - INTERVAL '${months} months'
      )
      SELECT
        c.cohort_month,
        a.activity_month,
        COUNT(DISTINCT c."brandId") as brands
      FROM cohorts c
      LEFT JOIN activity a ON a."brandId" = c."brandId"
      GROUP BY c.cohort_month, a.activity_month
      ORDER BY c.cohort_month, a.activity_month
    `)

    return { data: { months, cohorts: result } }
  }

  // =============================================================
  // Snapshots (para gráficas históricas)
  // =============================================================

  /**
   * Generar snapshot diario de métricas.
   * Llamado desde cron.
   */
  async generateDailySnapshot() {
    const today = new Date().toISOString().split('T')[0]

    // Verificar si ya existe
    const existing = await this.snapshotReadRepo.findOne({
      where: { date: today, type: 'daily_summary' },
    })
    if (existing) return

    const mrr = await this.getMRR()
    const arpu = await this.getARPU(30)

    // Conteo de suscriptores por plan
    const subscribersByPlan = await this.readDataSource.query(`
      SELECT "planSlug", status, COUNT(*) as count
      FROM subscriptions
      GROUP BY "planSlug", status
    `)

    const snapshot = this.snapshotRepo.create({
      date: today,
      type: 'daily_summary',
      data: {
        mrr: mrr.data,
        arpu: arpu.data,
        subscribersByPlan,
        generatedAt: new Date().toISOString(),
      },
    })

    await this.snapshotRepo.save(snapshot)
    this.logger.log(`Snapshot diario generado: ${today}`)
  }

  /**
   * Obtener snapshots históricos por tipo.
   */
  async getSnapshots(type: string, days = 30) {
    const since = new Date()
    since.setDate(since.getDate() - days)

    const snapshots = await this.snapshotReadRepo
      .createQueryBuilder('s')
      .where('s.type = :type', { type })
      .andWhere('s.date >= :since', { since: since.toISOString().split('T')[0] })
      .orderBy('s.date', 'ASC')
      .getMany()

    return { data: snapshots }
  }
}
