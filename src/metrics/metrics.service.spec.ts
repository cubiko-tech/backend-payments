import { INestApplication, ValidationPipe } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { ClientRolesService } from '../client/client-roles.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { MetricsSnapshot } from './entities/metricsSnapshot.entity'
import { MetricsController } from './metrics.controller'
import { MetricsService } from './metrics.service'

/**
 * Candado sobre los criterios de ESTADO de las métricas: qué fila cuenta como marca
 * paga y cuál como cliente con vida útil.
 *
 * Estos métodos no tienen otra superficie observable que su SQL: cuentan y promedian
 * filas con `readDataSource.query` sobre SQL crudo y devuelven un número, así que un
 * mock que responda `0` pasaría igual con cualquier criterio. Por eso los casos
 * assertean sobre el LITERAL de la consulta capturada. Es el techo de lo que se puede
 * fijar acá, y está declarado a propósito: lo que se protege es la lista de estados,
 * no el número.
 *
 * Los dos casos exigen la MISMA forma —enumerar— y no un estado puntual: lo que se
 * defiende es que ningún filtro de estas métricas vuelva a ser negativo, porque un
 * `!=` absorbe en silencio cada estado que se agregue al enum.
 */
describe('MetricsService — criterios de estado', () => {
  const construir = () => {
    const query = jest.fn().mockResolvedValue([{ count: '0' }])
    const service = new MetricsService(
      {} as any, // snapshotRepo
      {} as any, // snapshotReadRepo
      { query } as any, // readDataSource
      {} as any, // clientRoles
    )

    return { service, query }
  }

  // MUTACIÓN QUE LO PONE ROJO: agregar `'pending'` al `IN` de esa consulta ⇒ las altas
  // que abrieron el link y nunca lo aceptaron cuentan como convertidas y la tasa
  // free→paid se infla con suscripciones que no pagaron un peso.
  it('la conversión free→paid exige `active`/`trial` y no cuenta `pending`', async () => {
    const { service, query } = construir()

    await service.getConversion()

    const sql = query.mock.calls.map(([q]) => String(q)).join('\n')
    const consultaDePagas = query.mock.calls
      .map(([q]) => String(q))
      .find((q) => q.includes(`"planSlug" != 'free'`))

    expect(consultaDePagas).toBeDefined()
    expect(consultaDePagas).toContain(`status IN ('active', 'trial')`)
    expect(sql).not.toContain('pending')
  })

  // El LTV mide vida útil de CLIENTE, y su criterio también tiene que ser una lista
  // cerrada: con el filtro negativo original (`status != 'trial'`) `pending` entraba
  // solo y las altas que nunca aceptaron su link contaban como clientes con vida útil,
  // promediando hacia abajo el `avg_days_active` de cada plan.
  //
  // MUTACIÓN QUE LO PONE ROJO: volver el `WHERE` a `s.status != 'trial'` ⇒ ya no hay
  // enumeración y `pending` vuelve a colarse.
  it('el LTV enumera los estados que promedia y deja `pending` afuera', async () => {
    const { service, query } = construir()

    await service.getLTV()

    const sql = String(query.mock.calls[0][0])
    expect(sql).toContain(`s.status IN ('active', 'past_due', 'cancelled', 'expired')`)
    expect(sql).not.toContain('pending')
    expect(sql).not.toContain(`!=`)
  })
})

describe('MetricsService — MRR with an unresolved price', () => {
  it('leaves a plan without a COP price out of the total and names it', async () => {
    // Mutation: getMRR back to `getPlanPriceCents(...) || 0` counts `ghost` as MRR 0.
    const query = jest.fn().mockResolvedValue([
      { planSlug: 'pro', subscribers: '2' },
      { planSlug: 'ghost', subscribers: '3' },
    ])
    // R17: the roles client is another service; only the price it answers per plan matters here.
    const clientRoles = {
      getPlanPriceCents: jest.fn(async (slug: string) => (slug === 'pro' ? 10000 : null)),
    }
    const service = new MetricsService({} as any, {} as any, { query } as any, clientRoles as any)
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined)

    const { data } = await service.getMRR()

    expect(data.total).toBe(200)
    expect(data.byPlan.map((p) => p.planSlug)).toEqual(['pro'])
    expect(data.unpricedPlans).toEqual(['ghost'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ghost'))
  })
})

describe('MetricsService — each calculation with its case', () => {
  // R17: readDataSource is the database; the rows it answers are all each calculation reads.
  const serviceAnswering = (rows: unknown[]) => {
    const query = jest.fn().mockResolvedValue(rows)
    const service = new MetricsService({} as any, {} as any, { query } as any, {} as any)
    return { service, query }
  }
  // Row factory: each metric reads its own column set; overrides pick the values under test.
  const metricRow = (overrides: Record<string, unknown> = {}) => ({
    date: '2026-11-01T00:00:00.000Z',
    month: '2026-11-01T00:00:00.000Z',
    provider: 'confio',
    purpose: 'subscription',
    count: '1',
    total: '0',
    ...overrides,
  })

  it('revenue adds every completed row and rounds the total to cents', async () => {
    // Mutation: getRevenue returns `totalRevenue` without `Math.round(... * 100) / 100` → 1200.567, red.
    const rows = [
      metricRow({ total: '1000.456' }),
      metricRow({ provider: 'dropi', total: '200.111' }),
      metricRow({ provider: 'stripe', total: null }),
    ]
    const { service, query } = serviceAnswering(rows)

    const result = await service.getRevenue(14)

    expect(result).toEqual({ data: { days: 14, totalRevenue: 1200.57, breakdown: rows } })
    expect(String(query.mock.calls[0][0])).toContain(
      `p."paidAt" >= NOW() - make_interval(days => $1)`,
    )
    expect(query.mock.calls[0][1]).toEqual([14])
  })

  it('churn counts cancelled and expired events inside the requested months', async () => {
    // Mutation: the getChurn window shifted by one month (`months => $1 + 1`) → red.
    const rows = [metricRow({ churned: '2', new_subs: '5' })]
    const { service, query } = serviceAnswering(rows)

    const result = await service.getChurn(3)

    const sql = String(query.mock.calls[0][0])
    expect(result).toEqual({ data: { months: 3, monthly: rows } })
    expect(sql).toContain(`se."createdAt" >= NOW() - make_interval(months => $1)`)
    expect(sql).toContain(`FILTER (WHERE se."eventType" IN ('cancelled', 'expired')) as churned`)
    expect(query.mock.calls[0][1]).toEqual([3])
  })

  it('ARPU divides the revenue by paying brands, not by payments', async () => {
    // Mutation: the getARPU division uses `COUNT(*)` instead of the distinct brands → red.
    const { service, query } = serviceAnswering([
      metricRow({ paying_brands: '4', total_revenue: '400000', arpu: '100000.00' }),
    ])

    const result = await service.getARPU(15)

    expect(result.data).toMatchObject({
      days: 15,
      paying_brands: '4',
      total_revenue: '400000',
      arpu: '100000.00',
    })
    expect(String(query.mock.calls[0][0])).toContain(
      `ROUND(SUM(p.amount) / COUNT(DISTINCT p."brandId"), 2)`,
    )
    expect(query.mock.calls[0][1]).toEqual([15])
  })

  it('payment methods group the completed payments of the last 90 days by provider', async () => {
    // Mutation: the getPaymentMethods window becomes `INTERVAL '30 days'` → red.
    const rows = [
      metricRow({ count: '7', total: '70000' }),
      metricRow({ provider: 'dropi', count: '3' }),
    ]
    const { service, query } = serviceAnswering(rows)

    const result = await service.getPaymentMethods()

    const sql = String(query.mock.calls[0][0])
    expect(result).toEqual({ data: rows })
    expect(sql).toContain(`p.status = 'completed'`)
    expect(sql).toContain(`p."paidAt" >= NOW() - INTERVAL '90 days'`)
    expect(sql).toContain('GROUP BY p.provider')
  })

  it('retention only counts activity that is not a cancellation or an expiry', async () => {
    // Mutation: the getRetention activity filter drops its `NOT` before `IN ('cancelled', 'expired')` → red.
    const rows = [
      metricRow({ cohort_month: '2026-09-01', activity_month: '2026-10-01', brands: '6' }),
    ]
    const { service, query } = serviceAnswering(rows)

    const result = await service.getRetention(4)

    expect(result).toEqual({ data: { months: 4, cohorts: rows } })
    expect(String(query.mock.calls[0][0])).toContain(
      `se."eventType" NOT IN ('cancelled', 'expired')`,
    )
    expect(query.mock.calls[0][1]).toEqual([4])
  })
})

describe('Admin Metrics - range validation and SQL parameterization (PAYL-9)', () => {
  let app: INestApplication
  let query: jest.Mock
  let createQueryBuilder: jest.Mock

  beforeEach(async () => {
    query = jest.fn().mockResolvedValue([])
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }
    createQueryBuilder = jest.fn().mockReturnValue(qb)

    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [
        MetricsService,
        { provide: getRepositoryToken(MetricsSnapshot, 'DBWrite'), useValue: {} },
        {
          provide: getRepositoryToken(MetricsSnapshot, 'DBRead'),
          useValue: { createQueryBuilder },
        },
        { provide: getDataSourceToken('DBRead'), useValue: { query } },
        { provide: ClientRolesService, useValue: {} },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    await app.init()
  })

  afterEach(async () => {
    await app.close()
  })

  it('rejects with 400 without querying the database when days or months is not an integer or attempts SQL injection', async () => {
    const inyeccion = await request(app.getHttpServer())
      .get('/admin/metrics/churn')
      .query({ months: "1 months'; DROP TABLE x; --" })

    expect(inyeccion.status).toBe(400)
    expect(query).not.toHaveBeenCalled()

    const decimalDays = await request(app.getHttpServer())
      .get('/admin/metrics/revenue')
      .query({ days: '3.5' })

    expect(decimalDays.status).toBe(400)
    expect(query).not.toHaveBeenCalled()

    const textoHistory = await request(app.getHttpServer())
      .get('/admin/metrics/history')
      .query({ days: 'abc' })

    expect(textoHistory.status).toBe(400)
    expect(createQueryBuilder).not.toHaveBeenCalled()
  })

  it('rejects with 400 without querying the database when days or months is out of range (e.g. 9999 or 0)', async () => {
    for (const [ruta, param] of [
      ['/admin/metrics/revenue', { days: '9999' }],
      ['/admin/metrics/arpu', { days: '9999' }],
      ['/admin/metrics/history', { days: '9999' }],
      ['/admin/metrics/churn', { months: '9999' }],
      ['/admin/metrics/retention', { months: '9999' }],
      ['/admin/metrics/revenue', { days: '0' }],
      ['/admin/metrics/churn', { months: '0' }],
    ] as const) {
      const res = await request(app.getHttpServer()).get(ruta).query(param)
      expect(res.status).toBe(400)
    }

    expect(query).not.toHaveBeenCalled()
    expect(createQueryBuilder).not.toHaveBeenCalled()
  })

  it('passes days and months as a SQL parameter without interpolating the value across all five queries', async () => {
    const rev = await request(app.getHttpServer())
      .get('/admin/metrics/revenue')
      .query({ days: '17' })
    expect(rev.status).toBe(200)
    expect(String(query.mock.lastCall[0])).not.toContain('17')
    expect(String(query.mock.lastCall[0])).not.toContain('INTERVAL')
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [17])

    const churn = await request(app.getHttpServer())
      .get('/admin/metrics/churn')
      .query({ months: '5' })
    expect(churn.status).toBe(200)
    expect(String(query.mock.lastCall[0])).not.toContain('5')
    expect(String(query.mock.lastCall[0])).not.toContain('INTERVAL')
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [5])

    const arpu = await request(app.getHttpServer()).get('/admin/metrics/arpu').query({ days: '19' })
    expect(arpu.status).toBe(200)
    expect(String(query.mock.lastCall[0])).not.toContain('19')
    expect(String(query.mock.lastCall[0])).not.toContain('INTERVAL')
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [19])

    const ret = await request(app.getHttpServer())
      .get('/admin/metrics/retention')
      .query({ months: '3' })
    expect(ret.status).toBe(200)
    const retentionSql = String(query.mock.lastCall[0])
    expect(retentionSql).not.toContain('3')
    expect(retentionSql).not.toContain('INTERVAL')
    expect(retentionSql.match(/make_interval\(months => \$1\)/g)).toHaveLength(2)
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [3])
  })

  it('uses the current default when neither days nor months is provided (CA5)', async () => {
    const churn = await request(app.getHttpServer()).get('/admin/metrics/churn')
    expect(churn.status).toBe(200)
    expect(churn.body).toEqual({ data: { months: 6, monthly: [] } })
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [6])

    const retention = await request(app.getHttpServer()).get('/admin/metrics/retention')
    expect(retention.status).toBe(200)
    expect(retention.body).toEqual({ data: { months: 6, cohorts: [] } })
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [6])

    const revenue = await request(app.getHttpServer()).get('/admin/metrics/revenue')
    expect(revenue.status).toBe(200)
    expect(revenue.body).toEqual({ data: { days: 30, totalRevenue: 0, breakdown: [] } })
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [30])

    const arpu = await request(app.getHttpServer()).get('/admin/metrics/arpu')
    expect(arpu.status).toBe(200)
    expect(arpu.body).toEqual({ data: { days: 30 } })
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [30])

    const history = await request(app.getHttpServer()).get('/admin/metrics/history')
    expect(history.status).toBe(200)
    expect(createQueryBuilder).toHaveBeenCalledTimes(1)
  })
})
