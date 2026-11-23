import { Logger } from '@nestjs/common'

import { Subscription } from '../subscription/entities/subscription.entity'
import { renewFromWallet, SubscriptionRenewalDeps } from '../tasks/wallet-renewal'
import { ClientRolesService } from './client-roles.service'

// Restored by hand: `jest.restoreAllMocks()` does not undo a direct assignment to a global.
const REAL_FETCH = global.fetch
const ROLES_URL = 'https://roles.test.local'

const priceRow = (over: Record<string, unknown> = {}) => ({
  id: '1',
  countryCode: 'CO',
  currency: 'COP',
  price: '19900.00',
  isDefault: false,
  ...over,
})

const catalogResponse = (prices: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ data: [{ slug: 'pro', prices }] }),
})

// Stub: `GET /v1/plan` of backend-roles is the only boundary of the price client.
const mockCatalog = (prices: unknown[]) => jest.fn().mockResolvedValue(catalogResponse(prices))

/**
 * Debits one wallet renewal of a COP subscription through the real price client and returns the
 * amount debited. backend-roles answers `false` to the plan renewal, so the run stops after the debit.
 */
const debitedOnRenewal = async (service: ClientRolesService): Promise<number> => {
  jest.spyOn(service, 'renewPlanForBrand').mockResolvedValue(false)
  // Stub: the wallet is the charge edge; the case reads the amount it receives.
  const debit = jest.fn().mockResolvedValue({ data: {} })
  const deps = {
    clientRoles: service,
    walletReadRepo: { findOne: jest.fn().mockResolvedValue({ currency: 'COP' }) },
    transactionReadRepo: { findOne: jest.fn().mockResolvedValue(null) },
    walletService: { findDebitByIdempotencyKey: jest.fn().mockResolvedValue(null), debit },
    BILLING_PERIOD_DAYS: 30,
    RENEWAL_POSTPONEMENT_GRACE_HOURS: 24,
  } as unknown as SubscriptionRenewalDeps
  const sub = {
    id: 'sub-1',
    brandId: 'brand-1',
    planSlug: 'pro',
    walletId: 'wallet-1',
    nextBillingDate: new Date('2026-11-01T00:00:00Z'),
  } as Subscription

  await renewFromWallet(sub, deps)
  expect(debit).toHaveBeenCalledTimes(1)
  return debit.mock.calls[0][1]
}

describe('ClientRolesService — deterministic plan prices', () => {
  const OLD_ENV = process.env
  let service: ClientRolesService

  beforeEach(() => {
    process.env = { ...OLD_ENV, SERVICE_ROLES: ROLES_URL, ACCESS_SERVER: 'server-token-123' }
    service = new ClientRolesService()
  })

  afterEach(() => {
    process.env = OLD_ENV
    global.fetch = REAL_FETCH
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('debits the isDefault COP price of CO on a wallet renewal, whatever the row order', async () => {
    // Mutation: getPlanPriceCents takes the last row of the currency instead of pickPriceRow → red.
    const chosen = priceRow({ id: '7', price: '24900.00', isDefault: true })
    const other = priceRow({ id: '3', price: '19900.00' })

    global.fetch = mockCatalog([chosen, other]) as unknown as typeof fetch
    const firstOrder = await debitedOnRenewal(service)

    service = new ClientRolesService()
    global.fetch = mockCatalog([other, chosen]) as unknown as typeof fetch
    const secondOrder = await debitedOnRenewal(service)

    expect(firstOrder).toBe(24900)
    expect(secondOrder).toBe(24900)
  })

  it('takes the lowest id between two isDefault rows of one country and logs a warn', async () => {
    // Mutation (winner): pickPriceRow returns the first candidate without sorting by id → red.
    // Mutation (warn): pickPriceRow drops its warn call → red.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    global.fetch = mockCatalog([
      priceRow({ id: '9', price: '30000.00', isDefault: true }),
      priceRow({ id: '4', price: '25000.00', isDefault: true }),
    ]) as unknown as typeof fetch

    const result = await service.resolvePriceForCountry('pro', 'CO')

    expect(result.ok).toBe(true)
    expect(result.price.id).toBe('4')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('More than one isDefault'))
  })

  it("does not count isDefault: 'false' as a default row", async () => {
    // Mutation: the ingest reads isDefault back as `!!price.isDefault` → the 'false' row wins → red.
    global.fetch = mockCatalog([
      priceRow({ id: '8', price: '30000.00', isDefault: 'false' }),
      priceRow({ id: '2', price: '25000.00' }),
    ]) as unknown as typeof fetch

    const result = await service.resolvePriceForCountry('pro', 'CO')

    expect(result.ok).toBe(true)
    expect(result.price.id).toBe('2')
  })

  it('matches a CO brand with a row stored as " CO"', async () => {
    // Mutation: the ingest drops `.trim()` from countryCode → the row is not CO and it fails → red.
    global.fetch = mockCatalog([
      priceRow({ id: '5', countryCode: ' CO' }),
    ]) as unknown as typeof fetch

    const result = await service.resolvePriceForCountry('pro', 'CO')

    expect(result.ok).toBe(true)
    expect(result.price.id).toBe('5')
  })

  it('makes a single call to backend-roles for 10 concurrent reads after the TTL expires', async () => {
    // Mutation: refreshCatalog stops reusing inflightRefresh → 10 calls → red.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate'],
      now: new Date('2026-11-20T10:00Z'),
    })
    const fetchMock = mockCatalog([priceRow()])
    global.fetch = fetchMock as unknown as typeof fetch
    await service.getPlanPriceCents('pro', 'COP')

    jest.setSystemTime(new Date('2026-11-20T10:06Z'))
    const reads = Array.from({ length: 10 }, () => service.getPlanPriceCents('pro', 'COP'))

    await expect(Promise.all(reads)).resolves.toEqual(Array(10).fill(1990000))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a decimal amount in exact integer cents', async () => {
    // Mutation: decimalToCents turns a string with Math.trunc(Number(value) * 100) → 1998 → red.
    global.fetch = mockCatalog([
      priceRow({ currency: 'USD', price: '19.99' }),
    ]) as unknown as typeof fetch

    await expect(service.getPlanPriceCents('pro', 'USD')).resolves.toBe(1999)
  })

  it('keeps serving the cached catalog when backend-roles answers non-2xx after the TTL', async () => {
    // Mutation: fetchCatalogFromRoles drops its `!response.ok` throw → the error body empties it → red.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate'],
      now: new Date('2026-11-20T10:00Z'),
    })
    global.fetch = mockCatalog([priceRow()]) as unknown as typeof fetch
    await service.getPlanPriceCents('pro', 'COP')

    jest.setSystemTime(new Date('2026-11-20T10:06Z'))
    // Stub: backend-roles answering 503 with a body that would empty the catalog if it were read.
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({ data: [] }),
    }) as unknown as typeof fetch

    await expect(service.getPlanPriceCents('pro', 'COP')).resolves.toBe(1990000)
  })

  it('does not call backend-roles and has no price when SERVICE_ROLES is missing', async () => {
    // Mutation: fetchCatalogFromRoles drops its `!this.rolesUrl` throw → fetch is called → red.
    delete process.env.SERVICE_ROLES
    const fetchMock = mockCatalog([priceRow()])
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(service.getPlanPriceCents('pro', 'COP')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves the refreshed price after the TTL when backend-roles answers', async () => {
    // Mutation: getPlanRows serves any cache without checking CACHE_TTL_MS → the old price stays → red.
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'setImmediate'],
      now: new Date('2026-11-20T10:00Z'),
    })
    global.fetch = mockCatalog([priceRow()]) as unknown as typeof fetch
    await service.getPlanPriceCents('pro', 'COP')

    jest.setSystemTime(new Date('2026-11-20T10:06Z'))
    global.fetch = mockCatalog([priceRow({ price: '24900.00' })]) as unknown as typeof fetch

    await expect(service.getPlanPriceCents('pro', 'COP')).resolves.toBe(2490000)
  })
})
