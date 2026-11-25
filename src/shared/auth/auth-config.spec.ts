import { HttpStatus } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { FakeAuth, startFakeAuth } from '../../../test/support/fake-auth.server'
import { unknownServiceKeys } from '../../../test/support/service-credential.double'
import { ApiAuthGuard } from './api-auth.guard'
import { readAuthBody, readSessionClaims, SessionVerifier } from './session-verifier.service'

const JWT_SECRET = 'loc357-shared-hs256-secret'
const OWNER = 'owner-loc357'

class SubscriptionStub {}

function contextOf(headers: Record<string, string>) {
  const req: any = { headers, cookies: {} }
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => SubscriptionStub,
  } as any
  return { req, context }
}

const unsigned = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`

describe('The verifier reads what auth sends as typed values (LOC-357)', () => {
  it('leaves the auth answer unknown and the session claims typed until they are checked', async () => {
    // Mutation: readAuthBody returns Promise<any> again -> the @ts-expect-error is unused, TS2578.
    const body = await readAuthBody(new Response('{"valid":true}'))
    // @ts-expect-error auth's answer is unknown until each field is checked
    expect(body.valid).toBe(true)

    const claims = readSessionClaims(unsigned({ id: OWNER, sid: 's1' }))
    // @ts-expect-error a session claim the verifier never checked is not readable
    expect(claims?.isSuperAdmin).toBeUndefined()
  })
})

describe('Auth is reached through SERVER_AUTH when SERVICE_AUTH is empty (LOC-357)', () => {
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
    process.env = { ...previousEnv, SERVICE_AUTH: '', SERVER_AUTH: auth.url }
    auth.reset()
    auth.addAccount({ id: OWNER, isSuperAdmin: false, status: 'active' })
    guard = new ApiAuthGuard(
      new Reflector(),
      new SessionVerifier(),
      roles,
      unknownServiceKeys.useValue as never,
    )
  })

  it('confirms a session at the auth SERVER_AUTH names', async () => {
    // Mutation: authBaseUrl drops `|| process.env.SERVER_AUTH` in auth-config.ts -> 503, auth never asked.
    const { req, context } = contextOf({
      authorization: `Bearer ${auth.login(OWNER).sessionToken}`,
    })

    await expect(guard.canActivate(context)).resolves.toBe(true)
    expect(req.user).toEqual({ id: OWNER, isSuperAdmin: false, brand: null })
    expect(auth.requests).toEqual(['GET /auth/v1/auth/validate'])
  })

  it('sends an auto-login token to the auth SERVER_AUTH names', async () => {
    // Mutation: authBaseUrl drops `|| process.env.SERVER_AUTH` in auth-config.ts -> auth never asked.
    const token = unsigned({ client: 'dev-client', user: OWNER })
    const { context } = contextOf({ authorization: `Bearer ${token}` })

    // The fake auth has no /client/validate-token, so the token is refused once it arrives.
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: HttpStatus.UNAUTHORIZED,
    })
    expect(auth.requests).toEqual(['POST /auth/v1/client/validate-token'])
  })
})
