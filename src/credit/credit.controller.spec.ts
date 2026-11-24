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

  beforeAll(async () => {
    // R17: the controller only delegates; the case reads whether the service was reached.
    creditService = { createActivationRequest: jest.fn().mockResolvedValue({ id: 'req-1' }) }
    const moduleRef = await Test.createTestingModule({
      controllers: [CreditController],
      providers: [
        // R17: the controller only delegates; these cases read the HTTP answer, not the services.
        { provide: CreditService, useValue: creditService },
        { provide: ScaleConfigService, useValue: {} },
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
})
