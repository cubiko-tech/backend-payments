import { HttpStatus } from '@nestjs/common'
import { ApiAuthGuard } from './api-auth.guard'
import { API_PERMISSION_KEY, API_SUPER_ADMIN_KEY } from './require-permission.decorator'

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

  const makeGuard = (verify: jest.Mock) => new ApiAuthGuard(reflector, { verify } as any, roles)

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

  it('rejects Bearer CHANGEME with 401 when ACCESS_SERVER is CHANGEME', async () => {
    process.env.ACCESS_SERVER = 'CHANGEME'
    const g = makeGuard(
      jest.fn(() => {
        throw new Error('invalid signature')
      }),
    )

    await expect(g.canActivate(ctx({ authorization: 'Bearer CHANGEME' }))).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['', '   ', ' srv-secret', 'srv-secret '])(
    'rejects server token with 401 when ACCESS_SERVER is blank or has edge whitespace (%j)',
    async (invalidServerSecret) => {
      process.env.ACCESS_SERVER = invalidServerSecret
      const g = makeGuard(
        jest.fn(() => {
          throw new Error('invalid signature')
        }),
      )

      await expect(
        g.canActivate(
          ctx({ authorization: `Bearer ${invalidServerSecret.trim() || 'srv-secret'}` }),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.UNAUTHORIZED,
      })
    },
  )

  it.each(['CHANGEME', ' global', 'global '])(
    'skips local JWT verification and rejects with 401 when JWT_SECRET is %j',
    async (invalidJwtSecret) => {
      process.env.JWT_SECRET = invalidJwtSecret
      const verify = jest.fn().mockReturnValue({ id: 'u1' })
      const g = makeGuard(verify)

      await expect(
        g.canActivate(ctx({ authorization: 'Bearer some-token' })),
      ).rejects.toMatchObject({
        status: HttpStatus.UNAUTHORIZED,
      })
      expect(verify).not.toHaveBeenCalled()
    },
  )

  it('rejects non-superadmin user with 403 when class requires superadmin', async () => {
    const classTarget = class AdminStub {}
    reflector.get.mockImplementation((key: string, target: unknown) => {
      if (key === API_SUPER_ADMIN_KEY && target === classTarget) return true
      return undefined
    })
    const g = makeGuard(jest.fn().mockReturnValue({ id: 'u1', isSuperAdmin: false }))
    const context = {
      ...ctx({ authorization: 'Bearer valid-user-jwt' }),
      getClass: () => classTarget,
    }

    await expect(g.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
    expect(roles.checkPermission).not.toHaveBeenCalled()
  })

  it('allows superadmin and server token when class requires superadmin', async () => {
    const classTarget = class AdminStub {}
    reflector.get.mockImplementation((key: string, target: unknown) => {
      if (key === API_SUPER_ADMIN_KEY && target === classTarget) return true
      return undefined
    })
    const g = makeGuard(
      jest
        .fn()
        .mockReturnValueOnce({ id: 'admin-1', isSuperAdmin: true })
        .mockReturnValueOnce({ id: 'admin-role', role: 'superadmin' }),
    )
    const superAdminCtx = {
      ...ctx({ authorization: 'Bearer valid-superadmin-jwt' }),
      getClass: () => classTarget,
    }
    const roleSuperAdminCtx = {
      ...ctx({ authorization: 'Bearer valid-role-superadmin-jwt' }),
      getClass: () => classTarget,
    }
    const serverCtx = {
      ...ctx({ authorization: 'Bearer srv-secret' }),
      getClass: () => classTarget,
    }

    await expect(g.canActivate(superAdminCtx)).resolves.toBe(true)
    await expect(g.canActivate(roleSuperAdminCtx)).resolves.toBe(true)
    await expect(g.canActivate(serverCtx)).resolves.toBe(true)
    expect(roles.checkPermission).not.toHaveBeenCalled()
  })

  it('evaluates handler @RequirePermission before class @RequireSuperAdmin', async () => {
    const classTarget = class AdminStub {}
    const handlerTarget = () => undefined
    reflector.get.mockImplementation((key: string, target: unknown) => {
      if (key === API_PERMISSION_KEY && target === handlerTarget) return 'credit:runs'
      if (key === API_SUPER_ADMIN_KEY && target === classTarget) return true
      return undefined
    })
    roles.checkPermission.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const g = makeGuard(jest.fn().mockReturnValue({ id: 'credit-op', isSuperAdmin: false }))
    const makeHandlerCtx = () => ({
      ...ctx({ authorization: 'Bearer credit-op-jwt' }),
      getHandler: () => handlerTarget,
      getClass: () => classTarget,
    })

    await expect(g.canActivate(makeHandlerCtx())).resolves.toBe(true)
    expect(roles.checkPermission).toHaveBeenCalledWith('credit-op', 'credit:runs')

    await expect(g.canActivate(makeHandlerCtx())).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
  })
})
