import { HttpStatus } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'

import { FakeAuth, startFakeAuth } from '../../../test/support/fake-auth.server'
import { unknownServiceKeys } from '../../../test/support/service-credential.double'
import { ApiAuthGuard } from './api-auth.guard'
import { RequireSuperAdmin } from './require-permission.decorator'
import { SessionVerifier } from './session-verifier.service'

const JWT_SECRET = 'loc352-shared-hs256-secret'
const COOKIE = 'loc352-session'
const OWNER = 'owner-loc352'
const ADMIN = 'admin-loc352'

class SubscriptionStub {}
@RequireSuperAdmin()
class AdminPaymentsStub {}

function contextOf(
  target: object,
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {},
) {
  const req: any = { headers, cookies }
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => target,
  } as any
  return { req, context }
}

describe('ApiAuthGuard resolves a person through auth (LOC-352)', () => {
  // R17: no case here reaches a @RequirePermission route, so roles is never asked.
  const roles = { checkPermission: jest.fn() } as any
  const previousEnv = { ...process.env }
  let auth: FakeAuth
  let guard: ApiAuthGuard

  beforeAll(async () => {
    auth = await startFakeAuth(JWT_SECRET)
  })

  afterAll(async () => {
    process.env = previousEnv
    await auth.stop()
  })

  beforeEach(() => {
    // As in production: JWT_SECRET is set (main.ts requires it), so bringing back a local
    // HS256 check would really run.
    process.env = {
      ...previousEnv,
      SERVICE_AUTH: auth.url,
      JWT_SECRET,
      ACCESS_SERVER: 'srv-loc352',
      COOKIE_SESSION: COOKIE,
    }
    auth.reset()
    auth.addAccount({ id: OWNER, isSuperAdmin: false, status: 'active' })
    auth.addAccount({ id: ADMIN, isSuperAdmin: true, status: 'active' })
    guard = new ApiAuthGuard(
      new Reflector(),
      new SessionVerifier(),
      roles,
      unknownServiceKeys.useValue as never,
    )
  })

  const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

  it("admits the owner's EdDSA session token as Bearer, with what auth says of the account", async () => {
    // R15: red when 'EdDSA' leaves SESSION_ALGORITHMS in session-verifier.service.ts: 401.
    const { req, context } = contextOf(SubscriptionStub, bearer(auth.login(OWNER).sessionToken))

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(req.user).toEqual({ id: OWNER, isSuperAdmin: false, brand: null })
    expect(auth.requests).toEqual(['GET /auth/v1/auth/validate'])
  })

  it("admits the owner's HS256 session cookie, which the web front sends today", async () => {
    // R15: red when 'HS256' leaves SESSION_ALGORITHMS in session-verifier.service.ts: 401.
    const { req, context } = contextOf(
      SubscriptionStub,
      {},
      { [COOKIE]: auth.login(OWNER).cookieToken },
    )

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(req.user).toEqual({ id: OWNER, isSuperAdmin: false, brand: null })
  })

  it('refuses the refresh token of a live session with 401 without asking auth', async () => {
    // R15: red when the `typ === 'session'` check leaves readSessionClaims: auth gets asked.
    const { sid } = auth.login(OWNER)
    const refresh = auth.signWithAuthKey({ id: OWNER, sid, typ: 'refresh', aud: 'web-session' })
    const { req, context } = contextOf(SubscriptionStub, bearer(refresh))

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
    expect(auth.requests).toEqual([])
    expect(req.user).toBeUndefined()
  })

  it('refuses a session token for the MCP audience with 401 without asking auth', async () => {
    // R15: red when the `aud === 'web-session'` check leaves readSessionClaims: auth gets asked.
    const { sid } = auth.login(OWNER)
    const mcp = auth.signWithAuthKey({ id: OWNER, sid, typ: 'session', aud: 'mcp' })
    const { context } = contextOf(SubscriptionStub, bearer(mcp))

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
    expect(auth.requests).toEqual([])
  })

  it('refuses a JWT_SECRET token that claims super admin and names no session', async () => {
    // R15: red when resolvePersonToken verifies with JWT_SECRET again before asking auth: 200.
    const forged = new JwtService({ secret: JWT_SECRET }).sign({ id: ADMIN, isSuperAdmin: true })
    const { req, context } = contextOf(AdminPaymentsStub, bearer(forged))

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
    expect(auth.requests).toEqual([])
    expect(req.user).toBeUndefined()
  })

  it('refuses a JWT_SECRET token shaped as a session whose sid auth does not have', async () => {
    // R15: red when SessionVerifier.verify accepts a JWT_SECRET signature before fetching auth: 200.
    const forged = new JwtService({ secret: JWT_SECRET }).sign({
      id: ADMIN,
      isSuperAdmin: true,
      sid: 'sid-invented',
      typ: 'session',
      aud: 'web-session',
    })
    const { context } = contextOf(AdminPaymentsStub, bearer(forged))

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
    expect(auth.requests).toEqual(['GET /auth/v1/auth/validate'])
  })

  it('refuses a session token whose claims were altered after auth signed them', async () => {
    // R15: red when SessionVerifier.verify trusts the token's claims without asking auth: no 401.
    const [header, , signature] = auth.login(OWNER).sessionToken.split('.')
    const { sid } = auth.login(ADMIN)
    const claims = { id: ADMIN, sid, typ: 'session', aud: 'web-session' }
    const altered = `${header}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`
    const { context } = contextOf(AdminPaymentsStub, bearer(altered))

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
  })

  it('refuses with 401 the unexpired session of an account deactivated after login', async () => {
    // R15: red when SessionVerifier.verify trusts the token's claims without asking auth: 200.
    const { sessionToken } = auth.login(OWNER)
    await expect(
      guard.canActivate(contextOf(SubscriptionStub, bearer(sessionToken)).context),
    ).resolves.toBe(true)

    auth.deactivate(OWNER)
    const { req, context } = contextOf(SubscriptionStub, bearer(sessionToken))

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
    expect(req.user).toBeUndefined()
  })

  it('refuses with 401 when auth answers 200 for an account that is not active', async () => {
    // R15: red when the `user.status !== 'active'` check leaves SessionVerifier.verify: 200.
    const { sessionToken } = auth.login(OWNER)
    auth.answerWith(200, {
      valid: true,
      user: { id: OWNER, isSuperAdmin: false, status: 'inactive' },
    })
    const { context } = contextOf(SubscriptionStub, bearer(sessionToken))

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
  })

  it('refuses with 401 when auth answers 200 for another person than the token names', async () => {
    // R15: red when the `user.id !== claims.id` check leaves SessionVerifier.verify: 200 as admin.
    const { sessionToken } = auth.login(OWNER)
    auth.answerWith(200, { valid: true, user: { id: ADMIN, isSuperAdmin: true, status: 'active' } })
    const { context } = contextOf(AdminPaymentsStub, bearer(sessionToken))

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
  })

  it('answers 403 on a super admin route when the token claims super admin and auth says no', async () => {
    // R15: red when isSuperAdmin is read from the token claims instead of auth's answer: 200.
    const { sessionToken } = auth.login(OWNER, { isSuperAdmin: true })
    const { req, context } = contextOf(AdminPaymentsStub, bearer(sessionToken))

    await expect(guard.canActivate(context)).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN })
    expect(req.user).toEqual({ id: OWNER, isSuperAdmin: false, brand: null })
  })

  it("admits a super admin on a super admin route by auth's word", async () => {
    // R15: red when isSuperAdmin is hardcoded to false in SessionVerifier.verify: 403.
    const { context } = contextOf(AdminPaymentsStub, bearer(auth.login(ADMIN).sessionToken))

    await expect(guard.canActivate(context)).resolves.toBe(true)
  })

  it.each([
    ['429 (auth rate limit)', 429],
    ['500', 500],
    ['404 (wrong auth URL)', 404],
  ])('answers 503 AUTH_UNAVAILABLE, not 401, when auth answers %s', async (_label, status) => {
    // R15: red when a non-401/403 answer maps to null in SessionVerifier.verify: 401.
    const { sessionToken } = auth.login(OWNER)
    auth.answerWith(status, { code: 'whatever' })
    const { context } = contextOf(SubscriptionStub, bearer(sessionToken))

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'AUTH_UNAVAILABLE',
    })
  })
})

describe('SessionVerifier when auth is down (LOC-352)', () => {
  const previousEnv = { ...process.env }

  afterEach(() => {
    process.env = previousEnv
  })

  it('answers 503 AUTH_UNAVAILABLE when nothing listens at auth', async () => {
    // R15: red when the fetch catch in SessionVerifier.verify returns null: 401 logs people out.
    const auth = await startFakeAuth(JWT_SECRET)
    const { sessionToken } = auth.login(OWNER)
    process.env = { ...previousEnv, SERVICE_AUTH: auth.url }
    await auth.stop()

    await expect(new SessionVerifier().verify(sessionToken)).rejects.toMatchObject({
      status: HttpStatus.SERVICE_UNAVAILABLE,
      code: 'AUTH_UNAVAILABLE',
    })
  })

  it('answers 503 AUTH_UNAVAILABLE when auth stalls past the timeout', async () => {
    // R15: red when the AbortSignal leaves the fetch in SessionVerifier.verify: the case times out.
    const auth = await startFakeAuth(JWT_SECRET)
    process.env = { ...previousEnv, SERVICE_AUTH: auth.url }
    const { sessionToken } = auth.login(OWNER)
    auth.stall()

    try {
      await expect(new SessionVerifier().verify(sessionToken, 200)).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
      })
    } finally {
      await auth.stop()
    }
  }, 3000)
})
