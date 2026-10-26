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
