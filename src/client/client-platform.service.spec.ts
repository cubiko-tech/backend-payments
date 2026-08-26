import {
  BRAND_LOOKUP_UNAVAILABLE,
  BRAND_NOT_FOUND,
  BRAND_WITHOUT_COUNTRY,
  ClientPlatformService,
} from './client-platform.service'

/**
 * El servicio no tiene dependencias inyectadas, así que se construye con `new`
 * y la única frontera a falsear es `global.fetch`. Igual que en
 * `client-roles.service.spec.ts:16`: `jest.restoreAllMocks()` NO deshace una
 * asignación directa a un global, por eso guardamos la referencia real y la
 * reponemos en `afterEach`. Sin esto, cualquier suite posterior heredaría el
 * stub y "verificaría" contra una respuesta fija sin tocar la red.
 */
const REAL_FETCH = global.fetch

const PLATFORM_URL = 'https://platform.test.local'
const BRAND_ID = '72a8463b-b78e-4b31-b310-66a0985a10e6'

/**
 * Forma REAL de `GET /v1/brand/:id`, capturada con una sonda contra dev por
 * HTTPS vía gateway el 2026-08-25 (200, 636 bytes): 18 claves dentro de `data`.
 * Los valores están enmascarados salvo `country`, que es lo que se prueba. No
 * es una forma inferida de la documentación — un mock inventado daría verde con
 * el lector roto (AGENTS.md → lecciones curadas).
 */
const brandBody = (over: Record<string, unknown> = {}) => ({
  data: {
    id: BRAND_ID,
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
    name: 'xxxxx',
    slug: 'xxxxxxxxxx',
    description: 'xxxxxxx',
    country: 'CO',
    currency: 'COP',
    owner: '00000000-0000-4000-8000-000000000000',
    state: 'xxxxxxxxxxx',
    plan: 'xxxx',
    provider: null,
    isDeleted: false,
    estimatedSales: 'xxxx',
    industry: null,
    industrySlug: null,
    categories: [],
    flag: null,
    ...over,
  },
})

/** Respuesta 200 con el cuerpo dado. */
const mockOk = (body: unknown) =>
  jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })

/** Respuesta non-ok con el cuerpo literal que devolvió el gateway. */
const mockStatus = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: false, status, json: async () => body })

describe('ClientPlatformService — país de la marca', () => {
  const OLD_ENV = process.env
  let service: ClientPlatformService

  beforeEach(() => {
    process.env = {
      ...OLD_ENV,
      SERVICE_PLATFORM: PLATFORM_URL,
      ACCESS_SERVER: 'server-token-123',
    }
    service = new ClientPlatformService()
  })

  afterEach(() => {
    process.env = OLD_ENV
    global.fetch = REAL_FETCH
    jest.restoreAllMocks()
  })

  describe('getBrandCountry', () => {
    it('devuelve el país de la marca y consulta /v1/brand/:id con Bearer', async () => {
      const fetchMock = mockOk(brandBody())
      global.fetch = fetchMock as unknown as typeof fetch

      await expect(service.getBrandCountry(BRAND_ID)).resolves.toBe('CO')

      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe(`${PLATFORM_URL}/v1/brand/${BRAND_ID}`)
      expect(opts.headers.Authorization).toBe('Bearer server-token-123')
    })

    /**
     * El hook `toUpperCase()` de la entidad sólo corre en insert/update
     * (`backend-platform/src/cqrs/entities/brand/brand.entity.ts:110,121`), así
     * que una fila vieja o cargada por SQL/fixtures puede traer minúsculas o
     * espacios. La normalización es nuestra, no de platform.
     */
    it.each([
      ['minúsculas', 'co'],
      ['con espacios', '  co  '],
      ['ya normalizado', 'CO'],
    ])('normaliza el país (%s)', async (_caso, country) => {
      global.fetch = mockOk(brandBody({ country })) as unknown as typeof fetch

      await expect(service.getBrandCountry(BRAND_ID)).resolves.toBe('CO')
    })
  })

  describe('resolveBrandCountry — los dos modos de fallo NO se colapsan', () => {
    /**
     * Cuerpo LITERAL medido en la sonda: platform responde 404 a cualquier GET
     * cuyo token no resuelva (`auth.middleware.ts:35` lanza `NotFoundException`
     * sólo para GET). Es un fallo del CANAL, nunca un hecho sobre la marca.
     */
    it('404 (auth no resuelve) es transitorio: BRAND_LOOKUP_UNAVAILABLE y null sin lanzar', async () => {
      global.fetch = mockStatus(404, {
        message: 'Not Found',
        statusCode: 404,
      }) as unknown as typeof fetch

      const result = await service.resolveBrandCountry(BRAND_ID)
      expect(result.ok).toBe(false)
      expect(result.code).toBe(BRAND_LOOKUP_UNAVAILABLE)
      expect(result.code).not.toBe(BRAND_NOT_FOUND)

      global.fetch = mockStatus(404, { message: 'Not Found', statusCode: 404 }) as unknown as typeof fetch
      await expect(service.getBrandCountry(BRAND_ID)).resolves.toBeNull()
    })

    /**
     * Cuerpo LITERAL medido en la sonda con un UUID inexistente y token válido:
     * el controller devuelve `{ data: (await findById())[0] }`
     * (`brand.controller.ts:109`), o sea **200 con `{}`**. Ése —y sólo ése— es
     * el hecho definitivo "esa marca no está".
     */
    it('200 con `{}` (marca inexistente) es definitivo: BRAND_NOT_FOUND y null sin lanzar', async () => {
      global.fetch = mockOk({}) as unknown as typeof fetch

      const result = await service.resolveBrandCountry(BRAND_ID)
      expect(result.ok).toBe(false)
      expect(result.code).toBe(BRAND_NOT_FOUND)
      expect(result.code).not.toBe(BRAND_LOOKUP_UNAVAILABLE)

      global.fetch = mockOk({}) as unknown as typeof fetch
      await expect(service.getBrandCountry(BRAND_ID)).resolves.toBeNull()
    })

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['vacío', ''],
      ['en blanco', '   '],
    ])('la marca existe y no trae país (%s) → BRAND_WITHOUT_COUNTRY y null', async (_caso, country) => {
      global.fetch = mockOk(brandBody({ country })) as unknown as typeof fetch

      const result = await service.resolveBrandCountry(BRAND_ID)
      expect(result.ok).toBe(false)
      expect(result.code).toBe(BRAND_WITHOUT_COUNTRY)
      expect(result.code).not.toBe(BRAND_NOT_FOUND)

      global.fetch = mockOk(brandBody({ country })) as unknown as typeof fetch
      await expect(service.getBrandCountry(BRAND_ID)).resolves.toBeNull()
    })

    it('un fetch que rechaza (red caída) es transitorio y no propaga la excepción', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch

      const result = await service.resolveBrandCountry(BRAND_ID)
      expect(result.ok).toBe(false)
      expect(result.code).toBe(BRAND_LOOKUP_UNAVAILABLE)

      await expect(service.getBrandCountry(BRAND_ID)).resolves.toBeNull()
    })

    it('sin SERVICE_PLATFORM es transitorio y ni siquiera llama a fetch', async () => {
      process.env.SERVICE_PLATFORM = ''
      const fetchMock = jest.fn()
      global.fetch = fetchMock as unknown as typeof fetch

      const result = await service.resolveBrandCountry(BRAND_ID)
      expect(result.ok).toBe(false)
      expect(result.code).toBe(BRAND_LOOKUP_UNAVAILABLE)
      await expect(service.getBrandCountry(BRAND_ID)).resolves.toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('un 500 de platform es transitorio', async () => {
      global.fetch = mockStatus(500, { statusCode: 500 }) as unknown as typeof fetch

      const result = await service.resolveBrandCountry(BRAND_ID)
      expect(result.ok).toBe(false)
      expect(result.code).toBe(BRAND_LOOKUP_UNAVAILABLE)
    })

    /**
     * Limitación consciente: un brandId no-UUID hace que platform responda 400
     * (`ParseUUIDPipe`, cuerpo literal de la sonda) y acá cae en la rama
     * transitoria aunque sea un fallo definitivo del llamador. En payments el
     * brandId llega de un DTO ya validado; si aparece un camino con id libre,
     * hay que darle su propio código.
     */
    it('400 de un brandId no-UUID cae —a propósito— en la rama transitoria', async () => {
      global.fetch = mockStatus(400, {
        message: 'Validation failed (uuid is expected)',
        error: 'Bad Request',
        statusCode: 400,
      }) as unknown as typeof fetch

      const result = await service.resolveBrandCountry('no-es-uuid')
      expect(result.ok).toBe(false)
      expect(result.code).toBe(BRAND_LOOKUP_UNAVAILABLE)
    })
  })

  it('el caso feliz de resolveBrandCountry devuelve ok con el país normalizado', async () => {
    global.fetch = mockOk(brandBody({ country: ' co ' })) as unknown as typeof fetch

    const result = await service.resolveBrandCountry(BRAND_ID)
    expect(result.ok).toBe(true)
    expect(result.country).toBe('CO')
  })
})
