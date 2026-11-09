import { BONUS_CATALOG_MAX_AGE_MS, ClientRolesService } from './client-roles.service'

/**
 * `getTokensPerCycle` reads the `tokensPerCycle` of `GET /v1/plan` (LOC-227, LOC-214). The only
 * border faked is `global.fetch`, restored by hand: `restoreAllMocks` does not undo an assignment.
 */
const REAL_FETCH = global.fetch

const catalog = (plans: unknown[]) =>
  jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: plans }) })

const rolesDown = () => jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))

describe('ClientRolesService.getTokensPerCycle', () => {
  const OLD_ENV = process.env
  let service: ClientRolesService

  beforeEach(() => {
    process.env = { ...OLD_ENV, SERVICE_ROLES: 'https://roles.test.local', ACCESS_SERVER: 'tok' }
    service = new ClientRolesService()
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined)
    jest.spyOn((service as any).logger, 'error').mockImplementation(() => undefined)
    jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    process.env = OLD_ENV
    global.fetch = REAL_FETCH
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('returns the tokens per cycle of the plan, as a number or a numeric string', async () => {
    // R15: red if the catalog stops reading tokensPerCycle: both plans give 0.
    global.fetch = catalog([
      { slug: 'pro', tokensPerCycle: 500, prices: [] },
      { slug: 'max', tokensPerCycle: '1200', prices: [] },
    ]) as unknown as typeof fetch

    expect(await service.getTokensPerCycle('pro')).toBe(500)
    expect(await service.getTokensPerCycle('max')).toBe(1200)
  })

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -5],
    ['fractional', 1.5],
    ['exponential string', '1e-7'],
    ['text', 'many'],
    ['null', null],
    ['boolean', true],
    ['over the safe integer range', Number.MAX_SAFE_INTEGER + 2],
  ])('gives 0 when tokensPerCycle is %s', async (_name, value) => {
    // R15: red if any value that is not a positive integer passes through as tokens.
    global.fetch = catalog([{ slug: 'pro', tokensPerCycle: value, prices: [] }]) as any

    expect(await service.getTokensPerCycle('pro')).toBe(0)
  })

  it('gives 0 for a plan the catalog does not list', async () => {
    global.fetch = catalog([{ slug: 'pro', tokensPerCycle: 500, prices: [] }]) as any

    expect(await service.getTokensPerCycle('other')).toBe(0)
  })

  it('throws when backend-roles is down and there is no catalog, instead of giving 0', async () => {
    // R15: red if an unavailable catalog reads as a plan without bonus (the bonus would be lost).
    global.fetch = rolesDown() as unknown as typeof fetch

    await expect(service.getTokensPerCycle('pro')).rejects.toThrow('Plan catalog unavailable')
    expect(service.hasCachedPrices()).toBe(false)
  })

  it('serves a stale catalog younger than the bonus max age when backend-roles is down', async () => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate'],
      now: new Date('2026-11-09T10:00Z'),
    })
    global.fetch = catalog([{ slug: 'pro', tokensPerCycle: 500, prices: [] }]) as any
    await service.getTokensPerCycle('pro')

    jest.setSystemTime(new Date('2026-11-09T10:10Z'))
    global.fetch = rolesDown() as unknown as typeof fetch

    expect(await service.getTokensPerCycle('pro')).toBe(500)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('throws when the only catalog is older than the bonus max age and backend-roles is down', async () => {
    // R15: red if the bonus keeps serving a catalog of any age, like the prices do.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate'],
      now: new Date('2026-11-09T10:00Z'),
    })
    global.fetch = catalog([{ slug: 'pro', tokensPerCycle: 500, prices: [] }]) as any
    await service.getTokensPerCycle('pro')

    jest.setSystemTime(new Date(Date.now() + BONUS_CATALOG_MAX_AGE_MS))
    global.fetch = rolesDown() as unknown as typeof fetch

    await expect(service.getTokensPerCycle('pro')).rejects.toThrow('Plan catalog unavailable')
    // Prices keep serving that stale catalog: only the bonus has a max age.
    expect(await service.getAllPlanPrices()).toBeInstanceOf(Map)
    expect(service.hasCachedPrices()).toBe(true)
  })
})
