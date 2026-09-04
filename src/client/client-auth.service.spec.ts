import { ClientAuthService, USER_LOOKUP_UNAVAILABLE, USER_NOT_FOUND } from './client-auth.service'

/**
 * El servicio no tiene dependencias inyectadas, así que se construye con `new`
 * y la única frontera a falsear es `global.fetch`. Igual que en
 * `client-platform.service.spec.ts:16`: `jest.restoreAllMocks()` NO deshace una
 * asignación directa a un global, por eso guardamos la referencia real y la
 * reponemos en `afterEach`.
 */
const REAL_FETCH = global.fetch

const AUTH_URL = 'https://auth.test.local/auth/v1'
const USER_ID = 'a3333333-0000-4000-8000-000000000001'

/**
 * Forma REAL de `GET /user/:id`, capturada con una sonda contra dev por HTTPS
 * vía gateway el 2026-08-26 (`https://auth.roaxai.dev/auth/v1/user/{id}` con
 * `Bearer ACCESS_SERVER`): 200 con **20 claves** dentro de `data`. Los valores
 * están enmascarados salvo los cuatro que se prueban. No es una forma inferida
 * de la documentación — un mock inventado daría verde con el lector roto.
 */
const userBody = (over: Record<string, unknown> = {}) => ({
  data: {
    id: USER_ID,
    createdAt: '2000-01-01T00:00:00.000Z',
    updatedAt: '2000-01-01T00:00:00.000Z',
    email: 'usuario@roaxai.com',
    phone: '+573001234567',
    name: 'Ana Perez',
    deletedAt: null,
    lastAccess: '2000-01-01T00:00:00.000Z',
    countryRegistration: 'CO',
    callingCode: '57',
    role: 'xxxxx',
    rol: 'xxxx',
    status: 'xxxxxx',
    isVerificated: true,
    isSuperAdmin: true,
    acceptTerms: true,
    changePassword: false,
    support: null,
    flags: [],
    ally: { id: '00000000-0000-4000-8000-000000000000', slug: 'xxxxxxx' },
    ...over,
  },
})

const mockOk = (body: unknown) =>
  jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })

const mockStatus = (status: number, body: unknown) =>
  jest.fn().mockResolvedValue({ ok: false, status, json: async () => body })

describe('ClientAuthService — contacto del comprador', () => {
  const OLD_ENV = process.env
  let service: ClientAuthService

  beforeEach(() => {
    process.env = { ...OLD_ENV, SERVICE_AUTH: AUTH_URL, ACCESS_SERVER: 'server-token-123' }
    service = new ClientAuthService()
  })

  afterEach(() => {
    process.env = OLD_ENV
    global.fetch = REAL_FETCH
    jest.restoreAllMocks()
  })

  it('devuelve los cuatro campos y consulta /user/:id con Bearer', async () => {
    global.fetch = mockOk(userBody())

    const result = await service.resolveBuyerContact(USER_ID)

    expect(result).toEqual({
      ok: true,
      contact: {
        email: 'usuario@roaxai.com',
        name: 'Ana Perez',
        phone: '+573001234567',
        callingCode: '57',
      },
    })
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
    expect(url).toBe(`${AUTH_URL}/user/${USER_ID}`)
    expect(init.headers.Authorization).toBe('Bearer server-token-123')
  })

  it('NO propaga las claves de más del registro (PII y autorización)', async () => {
    global.fetch = mockOk(userBody())

    const result = await service.resolveBuyerContact(USER_ID)

    expect(Object.keys(result.contact).sort()).toEqual(['callingCode', 'email', 'name', 'phone'])
    expect(result.contact).not.toHaveProperty('isSuperAdmin')
    expect(result.contact).not.toHaveProperty('flags')
  })

  it('un UUID inexistente contesta 200 con [] → USER_NOT_FOUND (definitivo)', async () => {
    global.fetch = mockOk([])

    expect(await service.resolveBuyerContact(USER_ID)).toEqual({ ok: false, code: USER_NOT_FOUND })
  })

  it('un 200 sin id dentro de data también es USER_NOT_FOUND', async () => {
    global.fetch = mockOk({ data: {} })

    expect(await service.resolveBuyerContact(USER_ID)).toEqual({ ok: false, code: USER_NOT_FOUND })
  })

  it('sin token auth responde 401 → USER_LOOKUP_UNAVAILABLE (transitorio)', async () => {
    global.fetch = mockStatus(401, { code: 'unauthorized', error: 'Unauthorized', status: 401 })

    expect(await service.resolveBuyerContact(USER_ID)).toEqual({
      ok: false,
      code: USER_LOOKUP_UNAVAILABLE,
    })
  })

  it('un id no-UUID responde 400 y cae en la rama transitoria (limitación consciente)', async () => {
    global.fetch = mockStatus(400, {
      message: 'Validation failed (uuid is expected)',
      error: 'Bad Request',
      statusCode: 400,
    })

    expect(await service.resolveBuyerContact('no-es-uuid')).toEqual({
      ok: false,
      code: USER_LOOKUP_UNAVAILABLE,
    })
  })

  it('una excepción de red es transitoria, no un hecho sobre el usuario', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))

    expect(await service.resolveBuyerContact(USER_ID)).toEqual({
      ok: false,
      code: USER_LOOKUP_UNAVAILABLE,
    })
  })

  it('sin SERVICE_AUTH configurado no sale a la red y es transitorio', async () => {
    process.env.SERVICE_AUTH = ''
    global.fetch = mockOk(userBody())

    expect(await service.resolveBuyerContact(USER_ID)).toEqual({
      ok: false,
      code: USER_LOOKUP_UNAVAILABLE,
    })
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('escapa el id en la URL', async () => {
    global.fetch = mockOk(userBody())

    await service.resolveBuyerContact('a b/c')

    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(`${AUTH_URL}/user/a%20b%2Fc`)
  })
})
