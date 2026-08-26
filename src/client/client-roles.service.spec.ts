import {
  ClientRolesService,
  PLAN_NOT_FOUND,
  PRICE_NOT_FOUND_FOR_COUNTRY,
  PlanPriceRow,
} from './client-roles.service'

/**
 * El servicio no tiene dependencias inyectadas, así que se construye con `new`
 * y la única frontera a falsear es `global.fetch`. Igual que en
 * `confio.provider.spec.ts:11`: `jest.restoreAllMocks()` NO deshace una
 * asignación directa a un global, por eso guardamos la referencia real y la
 * reponemos en `afterEach`. Sin esto, cualquier suite posterior heredaría el
 * stub y "verificaría" contra una respuesta fija sin tocar la red.
 */
const REAL_FETCH = global.fetch

const ROLES_URL = 'https://roles.test.local'

/**
 * Fila tal como la devuelve `GET /v1/plan` (relación `prices`). `price` viaja
 * como STRING decimal porque `plan_prices.price` es `decimal(10,2)` en
 * backend-roles (`src/data/plan/entities/planPrice.entity.ts:14`).
 */
const priceRow = (over: Partial<Record<keyof PlanPriceRow, unknown>> = {}) => ({
  id: 'price-1',
  countryCode: 'CO',
  currency: 'COP',
  price: '19900.00',
  isDefault: true,
  ...over,
})

const mockPlans = (plans: unknown[]) =>
  jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ data: plans }),
  })

const dropiRoaxPlan = (prices: unknown[] = [priceRow(), priceRow({ id: 'price-2', countryCode: 'US', currency: 'USD', price: '6.99', isDefault: false })]) => ({
  slug: 'dropi-roax',
  prices,
})

describe('ClientRolesService', () => {
  const OLD_ENV = process.env
  let service: ClientRolesService

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      SERVICE_ROLES: ROLES_URL,
      ACCESS_SERVER: 'server-token-123',
    }
    service = new ClientRolesService()
  })

  afterEach(() => {
    process.env = OLD_ENV
    global.fetch = REAL_FETCH
    jest.restoreAllMocks()
  })

  describe('compatibilidad de getPlanPrice / getAllPlanPrices', () => {
    it('devuelve el número del precio aunque el API lo mande como string decimal, y consulta /v1/plan con Bearer', async () => {
      const fetchMock = mockPlans([dropiRoaxPlan()])
      global.fetch = fetchMock as unknown as typeof fetch

      await expect(service.getPlanPrice('dropi-roax', 'COP')).resolves.toBe(19900)

      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe(`${ROLES_URL}/v1/plan`)
      expect(opts.headers.Authorization).toBe('Bearer server-token-123')
    })

    it('devuelve null para una moneda que el plan no tiene', async () => {
      global.fetch = mockPlans([dropiRoaxPlan()]) as unknown as typeof fetch

      await expect(service.getPlanPrice('dropi-roax', 'MXN')).resolves.toBeNull()
    })

    it('devuelve null para un plan que no está en el catálogo', async () => {
      global.fetch = mockPlans([dropiRoaxPlan()]) as unknown as typeof fetch

      await expect(service.getPlanPrice('inexistente', 'COP')).resolves.toBeNull()
    })

    it('getAllPlanPrices sigue devolviendo Map<planSlug, Map<currency, price>>', async () => {
      global.fetch = mockPlans([dropiRoaxPlan()]) as unknown as typeof fetch

      const all = await service.getAllPlanPrices()
      expect(all).toBeInstanceOf(Map)
      expect(all.get('dropi-roax')).toBeInstanceOf(Map)
      expect(all.get('dropi-roax').get('COP')).toBe(19900)
      expect(all.get('dropi-roax').get('USD')).toBe(6.99)
    })

    it('mantiene el caso especial de free sin precios: 0 en COP y USD', async () => {
      global.fetch = mockPlans([{ slug: 'free', prices: [] }]) as unknown as typeof fetch

      await expect(service.getPlanPrice('free', 'COP')).resolves.toBe(0)
      await expect(service.getPlanPrice('free', 'USD')).resolves.toBe(0)
    })
  })

  describe('resolvePriceForCountry', () => {
    it('devuelve la fila completa del país pedido', async () => {
      global.fetch = mockPlans([dropiRoaxPlan()]) as unknown as typeof fetch

      const result = await service.resolvePriceForCountry('dropi-roax', 'US')
      expect(result.ok).toBe(true)
      expect(result.price).toEqual({
        id: 'price-2',
        countryCode: 'US',
        currency: 'USD',
        price: 6.99,
        isDefault: false,
      })
    })

    it('compara el país sin distinguir mayúsculas', async () => {
      global.fetch = mockPlans([dropiRoaxPlan()]) as unknown as typeof fetch

      const result = await service.resolvePriceForCountry('dropi-roax', 'co')
      expect(result.ok).toBe(true)
      expect(result.price.id).toBe('price-1')
    })

    it('devuelve PLAN_NOT_FOUND cuando el slug no está en el catálogo', async () => {
      global.fetch = mockPlans([dropiRoaxPlan()]) as unknown as typeof fetch

      const result = await service.resolvePriceForCountry('inexistente', 'CO')
      expect(result.ok).toBe(false)
      expect(result.code).toBe(PLAN_NOT_FOUND)
    })

    it('devuelve PRICE_NOT_FOUND_FOR_COUNTRY —código DISTINTO— si el plan existe pero no hay fila del país ni default', async () => {
      global.fetch = mockPlans([
        {
          slug: 'dropi-roax',
          prices: [priceRow({ id: 'p-us', countryCode: 'US', currency: 'USD', price: '6.99', isDefault: false })],
        },
      ]) as unknown as typeof fetch

      const result = await service.resolvePriceForCountry('dropi-roax', 'MX')
      expect(result.ok).toBe(false)
      expect(result.code).toBe(PRICE_NOT_FOUND_FOR_COUNTRY)
      expect(result.code).not.toBe(PLAN_NOT_FOUND)
    })

    /**
     * `isDefault` desempata entre filas del MISMO país; NO suple a un país
     * ausente. Caer a la fila de otro país le cobraría 19.900 COP a una marca
     * mexicana sin que nadie se entere, y el criterio 1 de la épica 002 pide lo
     * contrario: rechazar cuando el precio falta del catálogo.
     */
    it('rechaza cuando el país pedido no tiene fila, sin caer a la de otro país', async () => {
      global.fetch = mockPlans([
        {
          slug: 'dropi-roax',
          prices: [
            priceRow({ id: 'p-co', countryCode: 'CO', currency: 'COP', price: '19900.00', isDefault: true }),
            priceRow({ id: 'p-us', countryCode: 'US', currency: 'USD', price: '6.99', isDefault: false }),
          ],
        },
      ]) as unknown as typeof fetch

      const result = await service.resolvePriceForCountry('dropi-roax', 'MX')
      expect(result.ok).toBe(false)
      expect(result.code).toBe(PRICE_NOT_FOUND_FOR_COUNTRY)
    })

    /**
     * El ganador entre dos filas del MISMO país no puede depender del orden en
     * que backend-roles las devuelva: ambas permutaciones tienen que dar la
     * fila `isDefault`.
     */
    const noDefault = priceRow({ id: 'p-co-viejo', countryCode: 'CO', currency: 'COP', price: '9900.00', isDefault: false })
    const withDefault = priceRow({ id: 'p-co-default', countryCode: 'CO', currency: 'COP', price: '19900.00', isDefault: true })

    it.each([
      ['default primero', [withDefault, noDefault]],
      ['default segundo', [noDefault, withDefault]],
    ])('gana la fila isDefault del país sin importar el orden (%s)', async (_caso, prices) => {
      global.fetch = mockPlans([{ slug: 'dropi-roax', prices }]) as unknown as typeof fetch

      const result = await service.resolvePriceForCountry('dropi-roax', 'CO')
      expect(result.ok).toBe(true)
      expect(result.price.id).toBe('p-co-default')
    })

    /**
     * Decisión fijada a propósito: `free` no tiene filas de precio reales y NO
     * se le fabrica una sintética, así que la resolución por país falla con
     * PRICE_NOT_FOUND_FOR_COUNTRY (el plan SÍ existe). El alta que venga
     * después no debe leer eso como "plan inexistente" ni persistir un id de
     * precio inventado.
     */
    it('[agregado] free responde PRICE_NOT_FOUND_FOR_COUNTRY, no un precio fabricado', async () => {
      global.fetch = mockPlans([{ slug: 'free', prices: [] }]) as unknown as typeof fetch

      const result = await service.resolvePriceForCountry('free', 'CO')
      expect(result.ok).toBe(false)
      expect(result.code).toBe(PRICE_NOT_FOUND_FOR_COUNTRY)
    })
  })

  describe('caché', () => {
    it('reusa el caché entre llamadas y lo refresca después de invalidateCache()', async () => {
      const fetchMock = mockPlans([dropiRoaxPlan()])
      global.fetch = fetchMock as unknown as typeof fetch

      await service.getPlanPrice('dropi-roax', 'COP')
      await service.resolvePriceForCountry('dropi-roax', 'CO')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      service.invalidateCache()
      await service.getPlanPrice('dropi-roax', 'COP')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    /**
     * El tiempo se controla con `jest.spyOn(Date, 'now')` y no con fake timers:
     * los timers falsos interferirían con el `AbortSignal.timeout(10000)` del
     * fetch real.
     */
    it('sirve el caché vencido cuando el refresco a backend-roles falla', async () => {
      const t0 = 1_000_000
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0)

      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: [dropiRoaxPlan()] }) })
        .mockRejectedValue(new Error('ECONNREFUSED'))
      global.fetch = fetchMock as unknown as typeof fetch

      await expect(service.getPlanPrice('dropi-roax', 'COP')).resolves.toBe(19900)

      // Más allá del TTL de 5 minutos
      nowSpy.mockReturnValue(t0 + 6 * 60 * 1000)

      await expect(service.getPlanPrice('dropi-roax', 'COP')).resolves.toBe(19900)
      const stale = await service.resolvePriceForCountry('dropi-roax', 'CO')
      expect(stale.ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('sin caché y con backend-roles caído devuelve mapa vacío y PLAN_NOT_FOUND', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch

      const all = await service.getAllPlanPrices()
      expect(all.size).toBe(0)

      const result = await service.resolvePriceForCountry('dropi-roax', 'CO')
      expect(result.ok).toBe(false)
      expect(result.code).toBe(PLAN_NOT_FOUND)
    })
  })
})
