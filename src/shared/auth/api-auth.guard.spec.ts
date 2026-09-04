import { ApiAuthGuard } from './api-auth.guard'

const b64u = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64url')
const tokenWith = (payload: any) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(payload)}.sig`

function ctx(headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  const req: any = { headers, cookies }
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
  } as any
}

describe('ApiAuthGuard', () => {
  const reflector = { get: jest.fn() } as any
  const roles = { checkPermission: jest.fn() } as any
  let fetchMock: jest.Mock

  const makeGuard = (verify: jest.Mock) =>
    new ApiAuthGuard(reflector, { verify } as any, roles)

  beforeEach(() => {
    jest.clearAllMocks()
    reflector.get.mockReturnValue(undefined) // preapproval: sin @RequirePermission
    process.env.SERVICE_AUTH = 'http://auth.test/auth/v1'
    process.env.ACCESS_SERVER = 'srv-secret'
    process.env.JWT_SECRET = 'global'
    fetchMock = jest.fn()
    ;(global as any).fetch = fetchMock
  })

  it('sin token → 401', async () => {
    const g = makeGuard(jest.fn())
    await expect(g.canActivate(ctx())).rejects.toBeDefined()
  })

  it('server token → autoriza', async () => {
    const g = makeGuard(jest.fn())
    expect(await g.canActivate(ctx({ authorization: 'Bearer srv-secret' }))).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('verificación local OK → autoriza sin llamar al auth', async () => {
    const g = makeGuard(jest.fn().mockReturnValue({ user: 'u1' }))
    const t = tokenWith({ client: 'dev-client', user: 'u1' })
    expect(await g.canActivate(ctx({ authorization: `Bearer ${t}` }))).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('local falla → valida contra /client/validate-token → autoriza', async () => {
    const g = makeGuard(
      jest.fn(() => {
        throw new Error('invalid signature')
      }),
    )
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'tokenValidate', data: { user: 'u9', role: 'user' } }),
    })
    const t = tokenWith({ client: 'dev-client', user: 'u9' })
    expect(await g.canActivate(ctx({ authorization: `Bearer ${t}` }))).toBe(true)
    expect(fetchMock).toHaveBeenCalledWith(
      'http://auth.test/auth/v1/client/validate-token',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('local falla + auth rechaza el token → 401', async () => {
    const g = makeGuard(
      jest.fn(() => {
        throw new Error('invalid signature')
      }),
    )
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'tokenExpired' }) })
    const t = tokenWith({ client: 'dev-client' })
    await expect(g.canActivate(ctx({ authorization: `Bearer ${t}` }))).rejects.toBeDefined()
  })

  it('rol superadmin del auth bypassa RBAC en endpoint admin', async () => {
    reflector.get.mockReturnValue('credit:runs') // endpoint admin
    const g = makeGuard(
      jest.fn(() => {
        throw new Error('invalid signature')
      }),
    )
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'tokenValidate', data: { user: 'a1', role: 'superadmin' } }),
    })
    const t = tokenWith({ client: 'dropi' })
    expect(await g.canActivate(ctx({ authorization: `Bearer ${t}` }))).toBe(true)
    expect(roles.checkPermission).not.toHaveBeenCalled()
  })
})
