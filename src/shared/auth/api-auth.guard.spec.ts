import { HttpStatus } from '@nestjs/common'
import { unknownServiceKeys } from '../../../test/support/service-credential.double'
import { ApiAuthGuard } from './api-auth.guard'
import {
  AllowServerToken,
  API_PERMISSION_KEY,
  API_SESSION_ONLY_KEY,
  API_SUPER_ADMIN_KEY,
} from './require-permission.decorator'

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
    new ApiAuthGuard(reflector, { verify } as any, roles, unknownServiceKeys.useValue as never)
  // R17: stands for SessionVerifier.verify when the token is not a session auth confirms; the session
  // cases run against a fake auth in api-auth.guard.session.spec.ts.
  const noSession = () => jest.fn().mockResolvedValue(null)

  beforeEach(() => {
    jest.clearAllMocks()
    reflector.get.mockReturnValue(undefined) // preapproval: sin @RequirePermission
    process.env.SERVICE_AUTH = 'http://auth.test/auth/v1'
    process.env.ACCESS_SERVER = 'srv-secret'
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

  it('validates an auto-login token at /client/validate-token and lets it in', async () => {
    // R15: red when resolvePersonToken stops sending `client` tokens to validateViaAuth: 401.
    const g = makeGuard(noSession())
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

  it('answers 401 to an auto-login token that auth rejects', async () => {
    const g = makeGuard(noSession())
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ error: 'tokenExpired' }) })
    const t = tokenWith({ client: 'dev-client' })
    await expect(g.canActivate(ctx({ authorization: `Bearer ${t}` }))).rejects.toBeDefined()
  })

  const autoLoginAs = (data: Record<string, unknown>) => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ code: 'tokenValidate', data: { user: 'a1', ...data } }),
    })
    return `Bearer ${tokenWith({ client: 'dropi', user: 'a1', ...data })}`
  }
  const rejectLocal = () => makeGuard(noSession())

  it.each([
    ['role superadmin', { role: 'superadmin' }],
    ['isSuperAdmin true', { isSuperAdmin: true }],
  ])(
    'an auto-login token with %s goes through RBAC and gets 403 without the permission (LOC-143)',
    async (_l, data) => {
      // R15: red when validateViaAuth reads that claim from the auth answer again: RBAC is skipped.
      reflector.get.mockImplementation((key: string) =>
        key === API_PERMISSION_KEY ? 'credit:runs' : undefined,
      )
      roles.checkPermission.mockResolvedValue(false)

      await expect(
        rejectLocal().canActivate(ctx({ authorization: autoLoginAs(data) })),
      ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
      expect(roles.checkPermission).toHaveBeenCalledWith('a1', 'credit:runs')
    },
  )

  it.each([
    ['role superadmin', { role: 'superadmin' }],
    ['isSuperAdmin true', { isSuperAdmin: true }],
  ])(
    'an auto-login token with %s gets 403 on a @RequireSuperAdmin class (LOC-143)',
    async (_l, data) => {
      // R15: red when validateViaAuth reads that claim from the auth answer again: it resolves true.
      const classTarget = class AdminStub {}
      reflector.get.mockImplementation((key: string, target: unknown) =>
        key === API_SUPER_ADMIN_KEY && target === classTarget ? true : undefined,
      )
      const context = { ...ctx({ authorization: autoLoginAs(data) }), getClass: () => classTarget }

      await expect(rejectLocal().canActivate(context)).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects Bearer CHANGEME with 401 when ACCESS_SERVER is CHANGEME', async () => {
    process.env.ACCESS_SERVER = 'CHANGEME'
    const g = makeGuard(noSession())

    await expect(g.canActivate(ctx({ authorization: 'Bearer CHANGEME' }))).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['', '   ', ' srv-secret', 'srv-secret '])(
    'rejects server token with 401 when ACCESS_SERVER is blank or has edge whitespace (%j)',
    async (invalidServerSecret) => {
      process.env.ACCESS_SERVER = invalidServerSecret
      const g = makeGuard(noSession())

      await expect(
        g.canActivate(
          ctx({ authorization: `Bearer ${invalidServerSecret.trim() || 'srv-secret'}` }),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.UNAUTHORIZED,
      })
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
    const g = makeGuard(jest.fn().mockReturnValue({ id: 'admin-1', isSuperAdmin: true }))
    const superAdminCtx = {
      ...ctx({ authorization: 'Bearer valid-superadmin-jwt' }),
      getClass: () => classTarget,
    }
    const serverCtx = {
      ...ctx({ authorization: 'Bearer srv-secret' }),
      getClass: () => classTarget,
    }

    await expect(g.canActivate(superAdminCtx)).resolves.toBe(true)
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

  it('marks only the ACCESS_SERVER principal as server, never a JWT that claims it (LOC-133)', async () => {
    // R15: red when the JWT branch copies an `isServer` claim, or the server branch drops the mark.
    const serverReq: any = { headers: { authorization: 'Bearer srv-secret' }, cookies: {} }
    const forgedReq: any = { headers: { authorization: 'Bearer forged-jwt' }, cookies: {} }
    const forged = { id: 'server', isServer: true, isSuperAdmin: true }
    const g = makeGuard(jest.fn().mockReturnValue(forged))
    const contextOf = (req: any) => ({ ...ctx(), switchToHttp: () => ({ getRequest: () => req }) })

    await g.canActivate(contextOf(serverReq))
    await g.canActivate(contextOf(forgedReq))

    expect(serverReq.user.isServer).toBe(true)
    expect(forgedReq.user.isServer).toBeUndefined()
  })

  it('refuses the server token with 403 on a class marked @RequireSessionUser (LOC-133)', async () => {
    // R15: red when the guard reads the session-only mark from the handler alone: server gets in.
    const classTarget = class GiftStub {}
    reflector.get.mockImplementation((key: string, target: unknown) => {
      if ((key === API_SESSION_ONLY_KEY || key === API_SUPER_ADMIN_KEY) && target === classTarget) {
        return true
      }
      return undefined
    })
    const g = makeGuard(jest.fn().mockReturnValue({ id: 'admin-1', isSuperAdmin: true }))
    const withClass = (authorization: string) => ({
      ...ctx({ authorization }),
      getClass: () => classTarget,
    })

    await expect(g.canActivate(withClass('Bearer srv-secret'))).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
    await expect(g.canActivate(withClass('Bearer superadmin-jwt'))).resolves.toBe(true)
  })

  it('refuses the server token on a @RequirePermission handler of a session-only class without asking roles (LOC-271)', async () => {
    // R15: red when the permission branch drops its refusesServer check: the server passes as super admin.
    const handlerTarget = () => undefined
    const classTarget = class AdminStub {}
    reflector.get.mockImplementation((key: string, target: unknown) => {
      if (key === API_SESSION_ONLY_KEY && target === classTarget) return true
      if (key === API_PERMISSION_KEY && target === handlerTarget) return 'credit:runs'
      return undefined
    })
    const g = makeGuard(jest.fn())
    const context = {
      ...ctx({ authorization: 'Bearer srv-secret' }),
      getHandler: () => handlerTarget,
      getClass: () => classTarget,
    }

    await expect(g.canActivate(context)).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    expect(roles.checkPermission).not.toHaveBeenCalled()
  })

  it('keeps letting the server token in on a @RequirePermission handler with no session-only mark', async () => {
    // R15: red when the permission branch refuses the server on every route: CreditController is cut.
    const handlerTarget = () => undefined
    reflector.get.mockImplementation((key: string, target: unknown) =>
      key === API_PERMISSION_KEY && target === handlerTarget ? 'credit:runs' : undefined,
    )
    const g = makeGuard(jest.fn())
    const context = {
      ...ctx({ authorization: 'Bearer srv-secret' }),
      getHandler: () => handlerTarget,
      getClass: () => class CreditStub {},
    }

    await expect(g.canActivate(context)).resolves.toBe(true)
    expect(roles.checkPermission).not.toHaveBeenCalled()
  })

  it('lets the server token in on a handler marked @AllowServerToken of a session-only class (LOC-271)', async () => {
    // R15: red when the guard reads the class mark before the handler: the exception gets 403.
    const handlerTarget = () => undefined
    const classTarget = class AdminStub {}
    Reflect.defineMetadata(API_SESSION_ONLY_KEY, true, classTarget)
    AllowServerToken()(handlerTarget, 'handler', { value: handlerTarget })
    reflector.get.mockImplementation((key: string, target: object) =>
      Reflect.getMetadata(key, target),
    )
    const g = makeGuard(jest.fn().mockReturnValue({ id: 'admin-1', isSuperAdmin: true }))
    const withHandler = (handler: object) => ({
      ...ctx({ authorization: 'Bearer srv-secret' }),
      getHandler: () => handler,
      getClass: () => classTarget,
    })

    await expect(g.canActivate(withHandler(handlerTarget))).resolves.toBe(true)
    await expect(g.canActivate(withHandler(() => undefined))).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
  })
})
