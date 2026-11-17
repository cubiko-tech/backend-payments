/**
 * The week's TRM against PostgreSQL: stored once with the rate in force on the week's Monday, and
 * served to ROAX Ads by `GET /trm/usd-cop` when the day's TRM cannot be read.
 */
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import { randomUUID } from 'crypto'
import { config as dotenvConfig } from 'dotenv'
import * as request from 'supertest'
import { DataSource, In } from 'typeorm'
import { CreateTrmWeeklyRates1794415099807 } from '../migrations/1794415099807-CreateTrmWeeklyRates'
import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { ServiceCredentialService } from '../src/shared/auth/service-credential.service'
import { TrmWeeklyRate } from '../src/trm/entities/trm-weekly-rate.entity'
import { TrmController } from '../src/trm/trm.controller'
import { TrmWeeklyService, weekStartOf } from '../src/trm/trm-weekly.service'
import { TRM_SOURCE_URL, TrmService } from '../src/trm/trm.service'
import { startTrmSource, trmDown, trmOk, trmRow, TrmSource } from './support/trm-source.fixture'
import { raceConnectionOptions } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const ADS_KEY = `psk.roax-ads.${randomUUID()}`
const OTHER_SERVICE_KEY = `psk.roax-admin.${randomUUID()}`
// Weeks after any real one: the newest the table holds, and never a row the service stored.
const MONDAY = '2099-01-12'
const WEDNESDAY_NOON = Date.parse('2099-01-14T17:00:00Z')
const OLD_MONDAY = '2099-01-05'
// The source's row for that week: a weekend rate in force from Saturday through Monday.
const mondayRow = () => ({ status: 200, body: [trmRow('4000.00', '2099-01-10', MONDAY)] })

describe('Weekly TRM (PostgreSQL)', () => {
  let dataSource: DataSource
  let source: TrmSource
  let app: INestApplication
  let weekly: TrmWeeklyService

  const rows = () =>
    dataSource.getRepository(TrmWeeklyRate).findBy({ weekStart: In([MONDAY, OLD_MONDAY]) })
  const usdCop = (key: string | null = ADS_KEY) => {
    const call = request(app.getHttpServer()).get('/trm/usd-cop')
    return key ? call.set('Authorization', `Bearer ${key}`) : call
  }

  beforeAll(async () => {
    dataSource = new DataSource({ ...raceConnectionOptions(), entities: [TrmWeeklyRate] })
    await dataSource.initialize()
    const exists = await dataSource.query(`SELECT to_regclass('trm_weekly_rates') AS t`)
    if (!exists[0].t) {
      const runner = dataSource.createQueryRunner()
      try {
        await new CreateTrmWeeklyRates1794415099807().up(runner)
      } finally {
        await runner.release()
      }
    }
    source = await startTrmSource()
    // R17: service_credentials is cleared by another suite while it runs; its e2e proves the key.
    const credentials = {
      authenticate: jest.fn(async (key: string) =>
        key === ADS_KEY ? 'roax-ads' : key === OTHER_SERVICE_KEY ? 'roax-admin' : null,
      ),
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [TrmController],
      providers: [
        TrmService,
        TrmWeeklyService,
        Reflector,
        ApiAuthGuard,
        { provide: TRM_SOURCE_URL, useValue: source.url },
        { provide: JwtService, useValue: new JwtService({ secret: 'e2e-trm-weekly' }) },
        { provide: ServiceCredentialService, useValue: credentials },
        // R17: the route uses the service mark, never a roles permission.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
        {
          provide: getRepositoryToken(TrmWeeklyRate, 'DBWrite'),
          useValue: dataSource.getRepository(TrmWeeklyRate),
        },
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    await app.init()
    weekly = moduleRef.get(TrmWeeklyService)
  })

  beforeEach(async () => {
    await dataSource.getRepository(TrmWeeklyRate).delete({ weekStart: In([MONDAY, OLD_MONDAY]) })
    source.reply = trmOk
    source.hits = 0
    Object.assign(app.get(TrmService), { cached: undefined })
  })

  afterAll(async () => {
    await dataSource?.getRepository(TrmWeeklyRate).delete({ weekStart: In([MONDAY, OLD_MONDAY]) })
    await app?.close()
    await source?.close()
    await dataSource?.destroy()
  })

  it("on a Wednesday stores the rate in force on that week's Monday", async () => {
    source.reply = mondayRow
    const week = await weekly.recordThisWeek(WEDNESDAY_NOON)

    // Mutation: weekStartOf returns the day itself -> the week is 2099-01-14 and the source is asked for it.
    expect(week).toMatchObject({ weekStart: MONDAY, rate: 4000 })
    expect(decodeURIComponent(source.lastQuery)).toContain(`'${MONDAY}T00:00:00'`)
  })

  it('stores the week once: a second call neither asks the source nor adds a row', async () => {
    source.reply = mondayRow
    await weekly.recordThisWeek(WEDNESDAY_NOON)
    await weekly.recordThisWeek(WEDNESDAY_NOON)

    // Mutation: recordThisWeek skips the existing-row check -> the source is asked twice.
    expect(source.hits).toBe(1)
    expect(await rows()).toHaveLength(1)
  })

  it("answers ROAX Ads the day's TRM while the source answers", async () => {
    const res = await usdCop()

    // Mutation: usdCop answers the week's first -> source weekly.
    expect(res.status).toBe(HttpStatus.OK)
    expect(res.body).toMatchObject({ rate: 4000, source: 'daily' })
  })

  it("answers the newest week's TRM, marked weekly, when the source is down", async () => {
    await dataSource.getRepository(TrmWeeklyRate).insert([
      { weekStart: OLD_MONDAY, rate: 3900, rateDate: OLD_MONDAY },
      { weekStart: MONDAY, rate: 3297.07, rateDate: '2099-01-10' },
    ])
    source.reply = trmDown

    const res = await usdCop()

    // Mutation: latest() orders by weekStart ascending -> it answers an older week, not 3,297.07.
    expect(res.status).toBe(HttpStatus.OK)
    expect(res.body).toEqual({ rate: 3297.07, date: '2099-01-10', source: 'weekly' })
  })

  it("answers 503 with neither the day's TRM nor any weekly one", async () => {
    source.reply = trmDown
    // R17: the shared database may hold a real week; the case fixes that none is stored.
    jest.spyOn(weekly, 'latest').mockResolvedValueOnce(null)

    const res = await usdCop()

    // Mutation: usdCop answers a fixed rate when no week is stored -> 200 instead of 503.
    expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE)
    expect(res.body.code).toBe('EXCHANGE_RATE_UNAVAILABLE')
  })

  it('refuses another service client with a valid key, and a caller with none', async () => {
    const other = await usdCop(OTHER_SERVICE_KEY)
    const none = await usdCop(null)

    // Mutation: TrmController requires the roax-admin client -> the other service gets the TRM.
    expect(other.status).toBe(HttpStatus.FORBIDDEN)
    expect(none.status).toBe(HttpStatus.UNAUTHORIZED)
  })
})

describe('weekStartOf', () => {
  it('maps any day to the Monday of its week', () => {
    // Mutation: a week that starts on Sunday -> 2099-01-18 maps to itself.
    expect(weekStartOf('2099-01-14')).toBe(MONDAY)
    expect(weekStartOf(MONDAY)).toBe(MONDAY)
    expect(weekStartOf('2099-01-18')).toBe(MONDAY)
  })
})
