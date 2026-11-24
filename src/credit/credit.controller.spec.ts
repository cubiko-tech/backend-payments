import { ExecutionContext, INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'

import { ClientPlatformService } from '../client/client-platform.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { HttpErrorFilter } from '../shared/exception/http-error.filter'
import { createGlobalValidationPipe } from '../shared/validation/global-validation-pipe'
import { BureauService } from './bureau/bureau.service'
import { CreditRunService } from './credit-run.service'
import { CreditController } from './credit.controller'
import { CreditService } from './credit.service'
import { ScaleConfigService } from './scale-config.service'

const ACTIVATION_BODY = { fullName: 'Ana Pérez', email: 'ana@example.com', phone: '3001234567' }

describe('CreditController errors over HTTP', () => {
  let app: INestApplication
  let sessionUser: Record<string, unknown>
  let creditService: { createActivationRequest: jest.Mock }
  let scaleConfigService: { activateVersion: jest.Mock }

  beforeAll(async () => {
    // R17: the controller only delegates; the cases read whether the service was reached and with what.
    creditService = { createActivationRequest: jest.fn().mockResolvedValue({ id: 'req-1' }) }
    scaleConfigService = {
      activateVersion: jest.fn(async (version: number) => ({ version, status: 'active' })),
    }
    const moduleRef = await Test.createTestingModule({
      controllers: [CreditController],
      providers: [
        // R17: the controller only delegates; these cases read the HTTP answer, not the services.
        { provide: CreditService, useValue: creditService },
        { provide: ScaleConfigService, useValue: scaleConfigService },
        { provide: CreditRunService, useValue: {} },
        { provide: BureauService, useValue: {} },
        { provide: ClientPlatformService, useValue: {} },
      ],
    })
      // R17: the session comes from the case; ApiAuthGuard has its own specs.
      .overrideGuard(ApiAuthGuard)
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = sessionUser
          return true
        },
      })
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    app.useGlobalFilters(new HttpErrorFilter())
    await app.init()
  })

  beforeEach(() => {
    creditService.createActivationRequest.mockClear()
    scaleConfigService.activateVersion.mockClear()
  })

  afterAll(async () => {
    await app?.close()
  })

  it('answers an activation request from a session without brand with 400 BRAND_ID_REQUIRED', async () => {
    // R15: red when the controller throws brandRequired again: the code differs from subscription's.
    sessionUser = { id: 'user-1', isSuperAdmin: false, brand: null }

    const res = await request(app.getHttpServer())
      .post('/credit/activation-requests')
      .send(ACTIVATION_BODY)

    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      statusCode: 400,
      code: 'BRAND_ID_REQUIRED',
      message: 'La sesión no tiene marca',
    })
    expect(creditService.createActivationRequest).not.toHaveBeenCalled()
  })

  it.each(['1e-7', 'abc', 'null', '2147483648', '0', '-1'])(
    'answers POST /credit/config/scales/%s/activate with 400 INVALID_REQUEST without reaching the service',
    async (version) => {
      // Mutation (all rows): activateScale goes back to `Number(version)` without the pipe -> 201, red.
      sessionUser = { id: 'admin-1', isSuperAdmin: true, brand: null }

      const res = await request(app.getHttpServer()).post(
        `/credit/config/scales/${version}/activate`,
      )

      expect(res.status).toBe(400)
      expect(res.body).toEqual({
        statusCode: 400,
        code: 'INVALID_REQUEST',
        message: ['version must be an integer between 1 and 2147483647'],
      })
      expect(scaleConfigService.activateVersion).not.toHaveBeenCalled()
    },
  )

  it('activates POST /credit/config/scales/7/activate with the version as the number 7', async () => {
    // R15: red when the pipe's digit pattern needs two digits (`{2,10}`): a valid one-digit version is a 400.
    sessionUser = { id: 'admin-1', isSuperAdmin: true, brand: null }

    const res = await request(app.getHttpServer()).post('/credit/config/scales/7/activate')

    expect(res.status).toBe(201)
    expect(scaleConfigService.activateVersion).toHaveBeenCalledWith(7, 'admin-1')
  })
})
