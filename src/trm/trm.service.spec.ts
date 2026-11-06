import { HttpStatus } from '@nestjs/common'
import { TrmService } from './trm.service'
import {
  TRM_ROW,
  TrmSource,
  startTrmSource,
  trmDown,
  trmOk,
} from '../../test/support/trm-source.fixture'

const HOUR_MS = 60 * 60 * 1000
const T0 = Date.UTC(2026, 10, 6, 12)
const RATE = { rate: 4000, date: '2026-11-06' }
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
})
