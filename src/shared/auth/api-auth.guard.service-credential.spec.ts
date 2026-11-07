import { ExecutionContext, HttpStatus } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'

import { ClientRolesService } from '../../client/client-roles.service'
import { ApiAuthGuard } from './api-auth.guard'
import {
  API_PERMISSION_KEY,
  API_SERVICE_CLIENT_KEY,
  ROAX_ADS_CLIENT,
} from './require-permission.decorator'
import { ServiceCredentialService } from './service-credential.service'

const ADS_KEY = 'psk.roax-ads.secret'

describe('ApiAuthGuard with a service credential (LOC-173)', () => {
  const reflector = { get: jest.fn() }
  const roles = { checkPermission: jest.fn() }
  // R17: the lookup is ServiceCredentialService's; the e2e runs it against PostgreSQL.
  const credentials = { authenticate: jest.fn() }
  const fetchMock = jest.fn()

  const guard = (verify = jest.fn(), withCredentials = true) =>
    new ApiAuthGuard(
      reflector as unknown as Reflector,
      { verify } as unknown as JwtService,
      roles as unknown as ClientRolesService,
      withCredentials ? (credentials as unknown as ServiceCredentialService) : undefined,
    )
  const onRoute = (authorization: string, meta: Record<string, unknown>) => {
    const handlerTarget = () => undefined
    reflector.get.mockImplementation((key: string, target: unknown) =>
      target === handlerTarget ? meta[key] : undefined,
    )
    const req: { headers: object; cookies: object; user?: unknown } = {
      headers: { authorization },
      cookies: {},
    }
    const context = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => handlerTarget,
      getClass: () => class Stub {},
    } as unknown as ExecutionContext
    return { req, context }
  }

  beforeEach(() => {
    jest.resetAllMocks()
    process.env.SERVICE_AUTH = 'http://auth.test/auth/v1'
    process.env.ACCESS_SERVER = 'srv-secret'
    process.env.JWT_SECRET = 'global'
    global.fetch = fetchMock
  })

  it('resolves a valid key to a service identity that is not super admin', async () => {
    // R15: red when the service identity gets isSuperAdmin true or loses its client.
    credentials.authenticate.mockResolvedValue('roax-ads')
    const { req, context } = onRoute(`Bearer ${ADS_KEY}`, {
      [API_SERVICE_CLIENT_KEY]: ROAX_ADS_CLIENT,
    })

    await expect(guard().canActivate(context)).resolves.toBe(true)
    expect(req.user).toEqual({
      id: 'service:roax-ads',
      isSuperAdmin: false,
      brand: null,
      serviceClient: 'roax-ads',
    })
  })

  it('answers 401 to a key the service does not accept, without trying JWT or auth', async () => {
    // R15: red when a rejected key falls through to the JWT branch: verify is called.
    credentials.authenticate.mockResolvedValue(null)
    const verify = jest.fn().mockReturnValue({ id: 'u1', isSuperAdmin: true })
    const { context } = onRoute(`Bearer ${ADS_KEY}`, {})

    await expect(guard(verify).canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
    expect(verify).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers 401 to a key when the guard has no credential service', async () => {
    // R15: red when a missing service lets the key resolve to an identity: it answers 403.
    const { context } = onRoute(`Bearer ${ADS_KEY}`, {})

    await expect(guard(jest.fn(), false).canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
  })

  it.each([
    ['the server token', 'Bearer srv-secret'],
    ['a super admin session', 'Bearer superadmin-jwt'],
  ])('answers 403 to %s on a route that requires roax-ads', async (_label, authorization) => {
    // R15: red when the route mark is not checked: the super admin branch lets them in.
    const verify = jest.fn().mockReturnValue({ id: 'admin-1', isSuperAdmin: true })
    const { context } = onRoute(authorization, { [API_SERVICE_CLIENT_KEY]: ROAX_ADS_CLIENT })

    await expect(guard(verify).canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
  })

  it('answers 403 to another client on a route that requires roax-ads', async () => {
    // R15: red when the check accepts any service identity: other-service gets in.
    credentials.authenticate.mockResolvedValue('other-service')
    const { context } = onRoute('Bearer psk.other-service.secret', {
      [API_SERVICE_CLIENT_KEY]: ROAX_ADS_CLIENT,
    })

    await expect(guard().canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
  })

  it('answers 403 to the service on a @RequirePermission route without asking roles', async () => {
    // R15: red when the service check runs after the permission branch: roles is called.
    credentials.authenticate.mockResolvedValue('roax-ads')
    roles.checkPermission.mockResolvedValue(true)
    const { context } = onRoute(`Bearer ${ADS_KEY}`, { [API_PERMISSION_KEY]: 'credit:runs' })

    await expect(guard().canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
    })
    expect(roles.checkPermission).not.toHaveBeenCalled()
  })
})
