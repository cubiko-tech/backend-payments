/**
 * A session cookie with CR/LF in its signature, over HTTP through cookie-parser, the real guard and
 * the global error filter (LOC-356): it is a rejected token, not auth being down.
 */
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'

import { ClientRolesService } from '../src/client/client-roles.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { SessionVerifier } from '../src/shared/auth/session-verifier.service'
import { HttpErrorFilter } from '../src/shared/exception/http-error.filter'
import { logger } from '../src/shared/logger/logger'
import { FakeAuth, startFakeAuth } from './support/fake-auth.server'
import { unknownServiceKeys } from './support/service-credential.double'

const JWT_SECRET = 'loc356-shared-hs256-secret'
const COOKIE = 'loc356-session'
const OWNER = 'owner-loc356'

@Controller('e2e-session')
@UseGuards(ApiAuthGuard)
class SessionProbeController {
  @Get() read() {
    return { data: 'ok' }
  }
}

describe('Session cookie with CR/LF in its signature (LOC-356)', () => {
  const envSnapshot = { ...process.env }
  let auth: FakeAuth
  let app: INestApplication

  beforeAll(async () => {
    auth = await startFakeAuth(JWT_SECRET)
    process.env = {
      ...envSnapshot,
      SERVICE_AUTH: auth.url,
      JWT_SECRET,
      ACCESS_SERVER: 'srv-loc356',
      COOKIE_SESSION: COOKIE,
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [SessionProbeController],
      providers: [
        ApiAuthGuard,
        SessionVerifier,
        // R17: the probe route asks no permission, so roles is never reached.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
        unknownServiceKeys,
      ],
    }).compile()
    app = moduleRef.createNestApplication()
    app.use(cookieParser(JWT_SECRET))
    app.useGlobalFilters(new HttpErrorFilter())
    await app.init()
    auth.addAccount({ id: OWNER, isSuperAdmin: false, status: 'active' })
  })

  afterAll(async () => {
    await app?.close()
    await auth.stop()
    process.env = envSnapshot
  })

  afterEach(() => jest.restoreAllMocks())

  it('answers 401 without asking auth and without an error log', async () => {
    // Mutation: drop the base64url check in readSessionClaims -> 503 AUTH_UNAVAILABLE.
    const error = jest.spyOn(logger, 'error').mockImplementation(() => logger)
    const [header, payload] = auth.login(OWNER).cookieToken.split('.')

    const res = await request(app.getHttpServer())
      .get('/e2e-session')
      .set('Cookie', `${COOKIE}=${header}.${payload}.AAAA%0d%0aX-Injected:%201`)

    expect(res.status).toBe(401)
    expect(auth.requests).toEqual([])
    expect(error).not.toHaveBeenCalled()
  })
})
