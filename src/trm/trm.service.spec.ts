import { HttpStatus } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { TrmModule } from './trm.module'
import { TrmService } from './trm.service'
import {
  TRM_DAY,
  TRM_ROW,
  TrmSource,
  startTrmSource,
  trmDayPlus,
  trmDown,
  trmOk,
  trmRow,
} from '../../test/support/trm-source.fixture'
import { SilentUpstream, startSilentUpstream } from '../../test/support/silent-upstream.fixture'

const HOUR_MS = 60 * 60 * 1000
// Noon in Bogota on the day the default row is in force.
const T0 = Date.parse(`${TRM_DAY}T17:00:00Z`)
const RATE = { rate: 4000, date: TRM_DAY }
const UNAVAILABLE = { code: 'EXCHANGE_RATE_UNAVAILABLE', status: HttpStatus.SERVICE_UNAVAILABLE }

describe('TrmService', () => {
  let source: TrmSource

  beforeEach(async () => {
    source = await startTrmSource()
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await source.close()
  })

  it('returns the rate and the day it is valid from', async () => {
    // Mutation: drop Number() on `row.valor` and the string rate is rejected as unreadable.
    await expect(new TrmService(source.url).getUsdCopRate()).resolves.toEqual(RATE)
  })

  it('asks the source only for the row in force today in Bogota', async () => {
    // Mutation: drop the $where from the URL in fetchRate and the query has no date filter.
    await new TrmService(source.url).getUsdCopRate()
    const where = new URL(source.lastQuery, 'http://source').searchParams.get('$where')
    expect(where).toBe(
      `vigenciadesde <= '${TRM_DAY}T00:00:00' AND vigenciahasta >= '${TRM_DAY}T00:00:00'`,
    )
  })

  it("prices with today's row when the first row the source sends is in force from tomorrow", async () => {
    // Mutation: take rows[0] instead of the row in force in fetchRate and this resolves 4500.
    const tomorrow = trmDayPlus(1)
    source.reply = () => ({
      status: 200,
      body: [trmRow('4500.00', tomorrow), trmRow('4000.00', TRM_DAY)],
    })
    await expect(new TrmService(source.url).getUsdCopRate()).resolves.toEqual(RATE)
  })

  it.each([
    ['only a row in force from tomorrow', [trmRow('4500.00', trmDayPlus(1), trmDayPlus(2))]],
    ['only a row that expired yesterday', [trmRow('3900.00', trmDayPlus(-2), trmDayPlus(-1))]],
    [
      'a row without its last day',
      [{ valor: '4000.00', vigenciadesde: `${TRM_DAY}T00:00:00.000` }],
    ],
  ])('rejects with 503 when the source sends %s', async (_label, body) => {
    // Mutation: make isInForce return true and the row prices the payment.
    source.reply = () => ({ status: 200, body })
    await expect(new TrmService(source.url).getUsdCopRate()).rejects.toMatchObject(UNAVAILABLE)
  })

  it.each([
    ['1e10', '1e10'],
    ['just above the maximum', '10000.01'],
    ['just below the minimum', '1999.99'],
  ])('rejects with 503 a rate of %s, outside the credible range', async (_label, valor) => {
    // Mutation: drop the MIN/MAX_CREDIBLE_RATE bounds in fetchRate and the rate resolves.
    source.reply = () => ({ status: 200, body: [{ ...TRM_ROW, valor }] })
    await expect(new TrmService(source.url).getUsdCopRate()).rejects.toMatchObject(UNAVAILABLE)
  })

  it.each([
    ['the minimum', '2000.00', 2000],
    ['the maximum', '10000.00', 10000],
  ])('accepts a rate at %s of the credible range', async (_label, valor, rate) => {
    // Mutation: make the bounds exclusive in fetchRate and this rejects with 503.
    source.reply = () => ({ status: 200, body: [{ ...TRM_ROW, valor }] })
    await expect(new TrmService(source.url).getUsdCopRate()).resolves.toEqual({ ...RATE, rate })
  })

  it('queries the source once per hour', async () => {
    // Mutation: skip the fresh-cache check in getUsdCopRate and hits becomes 2.
    const service = new TrmService(source.url)
    await service.getUsdCopRate()
    await service.getUsdCopRate()
    expect(source.hits).toBe(1)
  })

  it('shares one request between concurrent callers with an empty cache', async () => {
    // Mutation: drop the in-flight promise reuse and hits becomes 2.
    const service = new TrmService(source.url)
    await Promise.all([service.getUsdCopRate(), service.getUsdCopRate()])
    expect(source.hits).toBe(1)
  })

  it('serves the fresh cache while the source is down', async () => {
    // Mutation: skip the fresh-cache check in getUsdCopRate and the second call rejects.
    const service = new TrmService(source.url)
    await service.getUsdCopRate()
    source.reply = trmDown
    await expect(service.getUsdCopRate()).resolves.toEqual(RATE)
    expect(source.hits).toBe(1)
  })

  it('does not serve a cached row past its last day, even within the hour', async () => {
    // Mutation: drop the `until` check from the cache in getUsdCopRate and hits stays at 1.
    source.reply = () => ({ status: 200, body: [trmRow('4000.00', TRM_DAY)] })
    const service = new TrmService(source.url)
    // Fixed clock: the case needs the day to change within the cache hour.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(`${trmDayPlus(1)}T04:40:00Z`))
    await service.getUsdCopRate()
    clock.mockReturnValue(Date.parse(`${trmDayPlus(1)}T05:10:00Z`))
    await expect(service.getUsdCopRate()).rejects.toMatchObject(UNAVAILABLE)
    expect(source.hits).toBe(2)
  })

  it('queries again once the hour has passed', async () => {
    // Mutation: drop the expiry from the cache check and hits stays at 1.
    const service = new TrmService(source.url)
    // Fixed clock: the cache lives one hour and the case cannot wait for it.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(T0)
    await service.getUsdCopRate()
    clock.mockReturnValue(T0 + HOUR_MS)
    await service.getUsdCopRate()
    expect(source.hits).toBe(2)
  })

  it('rejects with 503 when the cache expired and the source is down', async () => {
    // Mutation: keep serving an expired cache and this resolves with 4000.
    const service = new TrmService(source.url)
    // Fixed clock: the cache lives one hour and the case cannot wait for it.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(T0)
    await service.getUsdCopRate()
    clock.mockReturnValue(T0 + HOUR_MS)
    source.reply = trmDown
    await expect(service.getUsdCopRate()).rejects.toMatchObject(UNAVAILABLE)
  })

  it('rejects with 503 when the source is down and nothing is cached', async () => {
    // Mutation: return a fallback rate of 4000 on failure and this resolves.
    source.reply = trmDown
    await expect(new TrmService(source.url).getUsdCopRate()).rejects.toMatchObject(UNAVAILABLE)
  })

  it('rejects with 503 when the source host is unreachable', async () => {
    // Mutation: return a fallback rate of 4000 on a network error and this resolves.
    const service = new TrmService(source.url)
    await source.close()
    source = await startTrmSource()
    await expect(service.getUsdCopRate()).rejects.toMatchObject(UNAVAILABLE)
  })

  it.each([
    ['an empty list', []],
    ['a non-numeric rate', [{ ...TRM_ROW, valor: 'abc' }]],
    ['a zero rate', [{ ...TRM_ROW, valor: '0' }]],
    ['a missing date', [{ valor: '4000.00' }]],
  ])('rejects with 503 when the source returns %s', async (_label, body) => {
    // Mutation: drop the rate and date check in fetchRate and every row resolves.
    source.reply = () => ({ status: 200, body })
    await expect(new TrmService(source.url).getUsdCopRate()).rejects.toMatchObject(UNAVAILABLE)
  })

  it('does not cache a failure: the next call queries again', async () => {
    // Mutation: keep the failed promise in flight and the second call rejects without a hit.
    const service = new TrmService(source.url)
    source.reply = trmDown
    await expect(service.getUsdCopRate()).rejects.toMatchObject(UNAVAILABLE)
    source.reply = trmOk
    await expect(service.getUsdCopRate()).resolves.toEqual(RATE)
    expect(source.hits).toBe(2)
  })

  describe('with a caller timeout', () => {
    let silent: SilentUpstream

    beforeEach(async () => {
      silent = await startSilentUpstream()
    })

    afterEach(() => silent.close())

    // Outlives the 5 s query timeout, so a mutation shows as the measured time, not a jest timeout.
    const CASE_TIMEOUT_MS = 10_000

    it(
      'gives up with 503 at the caller timeout while the source is stalled',
      async () => {
        // Mutation: ignore timeoutMs in getUsdCopRate and it waits the 5 s query timeout.
        const started = Date.now()
        const service = new TrmService(silent.url)
        await expect(service.getUsdCopRate(300)).rejects.toMatchObject(UNAVAILABLE)
        expect(Date.now() - started).toBeLessThan(1500)
      },
      CASE_TIMEOUT_MS,
    )

    it('answers within the timeout from a fresh cache without a new query', async () => {
      // Mutation: apply the timeout before the cache check and a stalled source makes it reject.
      const service = new TrmService(source.url)
      await service.getUsdCopRate()
      await expect(service.getUsdCopRate(300)).resolves.toEqual(RATE)
      expect(source.hits).toBe(1)
    })
  })

  describe('TrmModule', () => {
    const envSnapshot = { ...process.env }

    afterEach(() => {
      process.env = { ...envSnapshot }
    })

    it('reads the source URL from TRM_SOURCE_URL', async () => {
      // Mutation: drop the TRM_SOURCE_URL provider from TrmModule and datos.gov.co is queried.
      process.env.TRM_SOURCE_URL = source.url
      const moduleRef = await Test.createTestingModule({ imports: [TrmModule] }).compile()
      await expect(moduleRef.get(TrmService).getUsdCopRate()).resolves.toEqual(RATE)
      expect(source.hits).toBe(1)
    })
  })
})
