// R6: Keeps all SubscriptionController route authorization and delegation specs in a single controller test file.
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import * as request from 'supertest'

import { SubscriptionController } from './subscription.controller'
import { SubscriptionService } from './subscription.service'
import { EnterprisePricingService } from './enterprise-pricing.service'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { RequestException } from '../shared/exception/request.exception'

const READS = [['getCurrent'], ['getAcceptanceLink'], ['getHistory'], ['confirm']] as const

const SERVER_PRINCIPAL = { id: 'server', isSuperAdmin: true, brand: null }
const READ_OWN_BRAND_ID = '11111111-1111-4111-8111-111111111111'
const READ_OTHER_SESSION_BRAND_ID = '44444444-4444-4444-8444-444444444444'
const READ_FOREIGN_BRAND_ID = '22222222-2222-4222-8222-222222222222'
const READ_USER_ID = '33333333-3333-4333-8333-333333333333'
const SUPERADMIN_PRINCIPAL = {
  id: '55555555-5555-4555-8555-555555555555',
  isSuperAdmin: true,
  brand: null,
}
const SERVER_TOKEN_PRINCIPAL = { id: 'server', isSuperAdmin: false, brand: null }
const USER_WITHOUT_BRAND = { id: READ_USER_ID, isSuperAdmin: false, brand: null }
const USER_WITH_OTHER_BRAND = {
  id: READ_USER_ID,
  isSuperAdmin: false,
  brand: READ_OTHER_SESSION_BRAND_ID,
}

describe('SubscriptionController — brand membership on subscription reads (LOC-60)', () => {
  let controller: SubscriptionController
  let service: Record<string, jest.Mock>
  let platformClient: { canViewBrandCredit: jest.Mock }

  async function expectRequestException(
    promise: Promise<unknown>,
    code: string,
    status: HttpStatus,
  ) {
    await expect(promise).rejects.toBeInstanceOf(RequestException)
    await promise.catch((error: RequestException) => {
      expect(error.getStatus()).toBe(status)
      expect(error.getResponse()).toMatchObject({ code })
    })
  }

  beforeEach(async () => {
    platformClient = {
      canViewBrandCredit: jest.fn().mockImplementation(async (userId: string, brandId: string) => {
        return userId === READ_USER_ID && brandId === READ_OWN_BRAND_ID
      }),
    }

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        {
          provide: SubscriptionService,
          useValue: {
            getCurrent: jest.fn().mockResolvedValue({ data: { brandId: READ_OWN_BRAND_ID } }),
            getAcceptanceLink: jest.fn().mockResolvedValue({ data: {} }),
            getHistory: jest.fn().mockResolvedValue({ data: [] }),
            confirm: jest.fn().mockResolvedValue({ data: {}, confirmed: false }),
          },
        },
        { provide: EnterprisePricingService, useValue: {} },
        { provide: ClientPlatformService, useValue: platformClient },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    controller = module.get<SubscriptionController>(SubscriptionController)
    service = module.get(SubscriptionService)
  })

  it.each(READS)(
    '%s: allows brand owner when session has no brand and resolves brandId from query',
    async (method) => {
      await controller[method](READ_OWN_BRAND_ID, { user: { ...USER_WITHOUT_BRAND } })

      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(
        READ_USER_ID,
        READ_OWN_BRAND_ID,
      )
      expect(service[method]).toHaveBeenCalledWith(READ_OWN_BRAND_ID)

      service[method].mockClear()
      platformClient.canViewBrandCredit.mockClear()

      await controller[method](READ_OWN_BRAND_ID, { user: { ...USER_WITH_OTHER_BRAND } })

      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(
        READ_USER_ID,
        READ_OWN_BRAND_ID,
      )
      expect(service[method]).toHaveBeenCalledWith(READ_OWN_BRAND_ID)
      expect(service[method]).not.toHaveBeenCalledWith(READ_OTHER_SESSION_BRAND_ID)
    },
  )

  it.each(READS)(
    '%s: rejects foreign brand with 403 forbidden without querying the subscription service',
    async (method) => {
      await expectRequestException(
        controller[method](READ_FOREIGN_BRAND_ID, { user: { ...USER_WITHOUT_BRAND } }),
        'forbidden',
        HttpStatus.FORBIDDEN,
      )

      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(
        READ_USER_ID,
        READ_FOREIGN_BRAND_ID,
      )
      expect(service[method]).not.toHaveBeenCalled()
    },
  )

  it.each(READS)(
    '%s: rejects missing or invalid brandId with 400 INVALID_BRAND_ID without querying',
    async (method) => {
      await expectRequestException(
        controller[method](undefined as unknown as string, { user: { ...USER_WITHOUT_BRAND } }),
        'INVALID_BRAND_ID',
        HttpStatus.BAD_REQUEST,
      )
      await expectRequestException(
        controller[method]('not-a-uuid', { user: { ...USER_WITHOUT_BRAND } }),
        'INVALID_BRAND_ID',
        HttpStatus.BAD_REQUEST,
      )
      await expectRequestException(
        controller[method](undefined as unknown as string, { user: { ...SERVER_PRINCIPAL } }),
        'INVALID_BRAND_ID',
        HttpStatus.BAD_REQUEST,
      )

      expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
      expect(service[method]).not.toHaveBeenCalled()
    },
  )

  it.each(READS)(
    '%s: allows superadmin and server principal to read any valid brand without membership lookup',
    async (method) => {
      await controller[method](READ_FOREIGN_BRAND_ID, { user: { ...SUPERADMIN_PRINCIPAL } })
      await controller[method](READ_FOREIGN_BRAND_ID, { user: { ...SERVER_TOKEN_PRINCIPAL } })

      expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
      expect(service[method]).toHaveBeenNthCalledWith(1, READ_FOREIGN_BRAND_ID)
      expect(service[method]).toHaveBeenNthCalledWith(2, READ_FOREIGN_BRAND_ID)
    },
  )
})

describe('SubscriptionController — alta paga', () => {
  let controller: SubscriptionController
  let service: Record<string, jest.Mock>

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        {
          provide: SubscriptionService,
          useValue: {
            startPaid: jest.fn().mockResolvedValue({ data: {}, acceptanceUrl: 'https://pay/x' }),
          },
        },
        { provide: EnterprisePricingService, useValue: {} },
        { provide: ClientPlatformService, useValue: { canViewBrandCredit: jest.fn() } },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    controller = module.get<SubscriptionController>(SubscriptionController)
    service = module.get(SubscriptionService)
  })

  it('delega el body validado al servicio y devuelve el link en el TOPE', async () => {
    // Mutación: que el handler arme el objeto a mano (por ejemplo agregando un
    // `provider` o leyendo la marca de otro lado) o que envuelva la respuesta en
    // `data` → este caso se pone rojo. El front lee `res.acceptanceUrl`.
    const body = { brandId: 'brand-1', userId: 'user-1', planSlug: 'dropi-roax' }

    const result = await controller.startPaid(body, {
      user: { id: 'user-1', isSuperAdmin: false, brand: 'brand-1' },
    })

    expect(service.startPaid).toHaveBeenCalledWith(body)
    expect(result.acceptanceUrl).toBe('https://pay/x')
  })
})

describe('SubscriptionController — enterprise pricing authorization (LOC-48)', () => {
  const OWN_BRAND_ID = '11111111-1111-4111-8111-111111111111'
  const FOREIGN_BRAND_ID = '22222222-2222-4222-8222-222222222222'
  const USER_ID = '33333333-3333-4333-8333-333333333333'
  const JWT_SECRET = 'loc48-test-jwt-secret'
  const SERVER_SECRET = 'loc48-test-server-secret'

  let app: INestApplication
  let jwtService: JwtService
  let userToken: string
  let superAdminToken: string
  let prevJwtSecret: string | undefined
  let prevAccessServer: string | undefined

  let subscriptionService: {
    create: jest.Mock
    startPaid: jest.Mock
  }
  let enterprisePricingService: {
    findAll: jest.Mock
    getForBrand: jest.Mock
    upsert: jest.Mock
    remove: jest.Mock
  }
  let platformClient: { canViewBrandCredit: jest.Mock }

  beforeAll(async () => {
    prevJwtSecret = process.env.JWT_SECRET
    prevAccessServer = process.env.ACCESS_SERVER
    process.env.JWT_SECRET = JWT_SECRET
    process.env.ACCESS_SERVER = SERVER_SECRET

    jwtService = new JwtService({ secret: JWT_SECRET })
    userToken = jwtService.sign({ id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID })
    superAdminToken = jwtService.sign({ id: 'user-superadmin', isSuperAdmin: true, brand: null })

    subscriptionService = {
      create: jest.fn().mockImplementation(async (data: any) => ({
        data: { id: 'sub-created', ...data },
      })),
      startPaid: jest.fn().mockImplementation(async (data: any) => ({
        data: { id: 'sub-paid', ...data },
        acceptanceUrl: 'https://pay.confio/accept',
      })),
    }
    enterprisePricingService = {
      findAll: jest.fn().mockResolvedValue({
        data: [{ id: 'ep-1', brandId: OWN_BRAND_ID, monthlyPrice: 500000, currency: 'COP' }],
      }),
      getForBrand: jest.fn().mockImplementation(async (brandId: string) => ({
        id: 'ep-1',
        brandId,
        monthlyPrice: 500000,
        currency: 'COP',
      })),
      upsert: jest.fn().mockImplementation(async (brandId: string, data: any) => ({
        data: { id: 'ep-1', brandId, ...data },
      })),
      remove: jest.fn().mockResolvedValue({ data: { success: true } }),
    }
    platformClient = {
      canViewBrandCredit: jest.fn().mockImplementation(async (userId: string, brandId: string) => {
        return userId === USER_ID && brandId === OWN_BRAND_ID
      }),
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        ApiAuthGuard,
        Reflector,
        { provide: JwtService, useValue: jwtService },
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
        { provide: SubscriptionService, useValue: subscriptionService },
        { provide: EnterprisePricingService, useValue: enterprisePricingService },
        { provide: ClientPlatformService, useValue: platformClient },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    await app.init()
  })

  afterAll(async () => {
    try {
      if (app) {
        await app.close()
      }
    } finally {
      process.env.JWT_SECRET = prevJwtSecret
      process.env.ACCESS_SERVER = prevAccessServer
    }
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('rejects GET /subscription/enterprise-pricing for a regular user and allows operator', async () => {
    const forbiddenRes = await request(app.getHttpServer())
      .get('/subscription/enterprise-pricing')
      .set('Authorization', `Bearer ${userToken}`)

    expect(forbiddenRes.status).toBe(403)
    expect(forbiddenRes.body).toMatchObject({ code: 'forbidden' })
    expect(enterprisePricingService.findAll).not.toHaveBeenCalled()

    const superAdminRes = await request(app.getHttpServer())
      .get('/subscription/enterprise-pricing')
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(superAdminRes.status).toBe(200)
    expect(superAdminRes.body).toEqual({
      data: [{ id: 'ep-1', brandId: OWN_BRAND_ID, monthlyPrice: 500000, currency: 'COP' }],
    })
    expect(enterprisePricingService.findAll).toHaveBeenCalledTimes(1)

    const serverRes = await request(app.getHttpServer())
      .get('/subscription/enterprise-pricing')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(serverRes.status).toBe(200)
    expect(enterprisePricingService.findAll).toHaveBeenCalledTimes(2)
  })

  it('rejects GET /subscription/enterprise-pricing/:brandId for foreign brand', async () => {
    const foreignRes = await request(app.getHttpServer())
      .get(`/subscription/enterprise-pricing/${FOREIGN_BRAND_ID}`)
      .set('Authorization', `Bearer ${userToken}`)

    expect(foreignRes.status).toBe(403)
    expect(foreignRes.body).toMatchObject({ code: 'forbidden' })
    expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, FOREIGN_BRAND_ID)
    expect(enterprisePricingService.getForBrand).not.toHaveBeenCalled()

    const ownRes = await request(app.getHttpServer())
      .get(`/subscription/enterprise-pricing/${OWN_BRAND_ID}`)
      .set('Authorization', `Bearer ${userToken}`)

    expect(ownRes.status).toBe(200)
    expect(ownRes.body).toEqual({
      data: { id: 'ep-1', brandId: OWN_BRAND_ID, monthlyPrice: 500000, currency: 'COP' },
    })
    expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, OWN_BRAND_ID)
    expect(enterprisePricingService.getForBrand).toHaveBeenCalledWith(OWN_BRAND_ID)

    platformClient.canViewBrandCredit.mockClear()

    const superAdminRes = await request(app.getHttpServer())
      .get(`/subscription/enterprise-pricing/${FOREIGN_BRAND_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(superAdminRes.status).toBe(200)
    expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
    expect(enterprisePricingService.getForBrand).toHaveBeenCalledWith(FOREIGN_BRAND_ID)

    const serverRes = await request(app.getHttpServer())
      .get(`/subscription/enterprise-pricing/${FOREIGN_BRAND_ID}`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(serverRes.status).toBe(200)
    expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
    expect(enterprisePricingService.getForBrand).toHaveBeenCalledWith(FOREIGN_BRAND_ID)
  })

  it('rejects POST /subscription/enterprise-pricing/:brandId for a regular user and allows operator', async () => {
    const payload = {
      monthlyPrice: 100,
      currency: 'COP',
      negotiatedBy: 'user-regular',
      validUntil: '2027-01-01T00:00:00.000Z',
      notes: 'unauthorized attempt',
    }

    const forbiddenRes = await request(app.getHttpServer())
      .post(`/subscription/enterprise-pricing/${FOREIGN_BRAND_ID}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send(payload)

    expect(forbiddenRes.status).toBe(403)
    expect(forbiddenRes.body).toMatchObject({ code: 'forbidden' })
    expect(enterprisePricingService.upsert).not.toHaveBeenCalled()

    const superAdminRes = await request(app.getHttpServer())
      .post(`/subscription/enterprise-pricing/${FOREIGN_BRAND_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(payload)

    expect(superAdminRes.status).toBe(201)
    expect(enterprisePricingService.upsert).toHaveBeenCalledWith(FOREIGN_BRAND_ID, {
      ...payload,
      validUntil: new Date('2027-01-01T00:00:00.000Z'),
    })

    const serverRes = await request(app.getHttpServer())
      .post(`/subscription/enterprise-pricing/${FOREIGN_BRAND_ID}`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(payload)

    expect(serverRes.status).toBe(201)
    expect(enterprisePricingService.upsert).toHaveBeenCalledTimes(2)
  })

  it('rejects DELETE /subscription/enterprise-pricing/:brandId for a regular user and allows operator', async () => {
    const forbiddenRes = await request(app.getHttpServer())
      .delete(`/subscription/enterprise-pricing/${FOREIGN_BRAND_ID}`)
      .set('Authorization', `Bearer ${userToken}`)

    expect(forbiddenRes.status).toBe(403)
    expect(forbiddenRes.body).toMatchObject({ code: 'forbidden' })
    expect(enterprisePricingService.remove).not.toHaveBeenCalled()

    const superAdminRes = await request(app.getHttpServer())
      .delete(`/subscription/enterprise-pricing/${FOREIGN_BRAND_ID}`)
      .set('Authorization', `Bearer ${superAdminToken}`)

    expect(superAdminRes.status).toBe(200)
    expect(superAdminRes.body).toEqual({ data: { success: true } })
    expect(enterprisePricingService.remove).toHaveBeenCalledWith(FOREIGN_BRAND_ID)

    const serverRes = await request(app.getHttpServer())
      .delete(`/subscription/enterprise-pricing/${FOREIGN_BRAND_ID}`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)

    expect(serverRes.status).toBe(200)
    expect(serverRes.body).toEqual({ data: { success: true } })
    expect(enterprisePricingService.remove).toHaveBeenCalledTimes(2)
  })

  it('rejects POST /subscription for a regular user without writing and allows operator and service token', async () => {
    const payload = {
      brandId: FOREIGN_BRAND_ID,
      userId: USER_ID,
      planSlug: 'pro',
      status: 'active',
    }

    const forbiddenRes = await request(app.getHttpServer())
      .post('/subscription')
      .set('Authorization', `Bearer ${userToken}`)
      .send(payload)

    expect(forbiddenRes.status).toBe(403)
    expect(forbiddenRes.body).toMatchObject({ code: 'forbidden' })
    expect(subscriptionService.create).not.toHaveBeenCalled()

    const superAdminRes = await request(app.getHttpServer())
      .post('/subscription')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send(payload)

    expect(superAdminRes.status).toBe(201)
    expect(subscriptionService.create).toHaveBeenCalledWith({
      ...payload,
      currentPeriodStart: undefined,
      currentPeriodEnd: undefined,
      nextBillingDate: undefined,
    })

    const serverRes = await request(app.getHttpServer())
      .post('/subscription')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send(payload)

    expect(serverRes.status).toBe(201)
    expect(subscriptionService.create).toHaveBeenCalledTimes(2)
  })

  it('rejects POST /subscription/paid for a foreign brand without calling Confio and allows own brand', async () => {
    const foreignPayload = {
      brandId: FOREIGN_BRAND_ID,
      userId: USER_ID,
      planSlug: 'dropi-roax',
    }

    const forbiddenRes = await request(app.getHttpServer())
      .post('/subscription/paid')
      .set('Authorization', `Bearer ${userToken}`)
      .send(foreignPayload)

    expect(forbiddenRes.status).toBe(403)
    expect(forbiddenRes.body).toMatchObject({ code: 'forbidden' })
    expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, FOREIGN_BRAND_ID)
    expect(subscriptionService.startPaid).not.toHaveBeenCalled()

    const ownPayload = {
      brandId: OWN_BRAND_ID,
      userId: USER_ID,
      planSlug: 'dropi-roax',
    }

    const ownRes = await request(app.getHttpServer())
      .post('/subscription/paid')
      .set('Authorization', `Bearer ${userToken}`)
      .send(ownPayload)

    expect(ownRes.status).toBe(201)
    expect(ownRes.body.acceptanceUrl).toBe('https://pay.confio/accept')
    expect(subscriptionService.startPaid).toHaveBeenCalledWith(ownPayload)
  })
})

describe('SubscriptionController — brand resolution on subscription writes', () => {
  const OWN_BRAND_ID = '11111111-1111-4111-8111-111111111111'
  const MEMBER_BRAND_ID = '44444444-4444-4444-8444-444444444444'
  const FOREIGN_BRAND_ID = '22222222-2222-4222-8222-222222222222'
  const USER_ID = '33333333-3333-4333-8333-333333333333'

  let controller: SubscriptionController
  let service: {
    startTrial: jest.Mock
    startPaid: jest.Mock
    changePlan: jest.Mock
    cancel: jest.Mock
    reactivate: jest.Mock
  }
  let platformClient: { canViewBrandCredit: jest.Mock }

  async function expectWriteException(promise: Promise<unknown>, code: string, status: HttpStatus) {
    await expect(promise).rejects.toBeInstanceOf(RequestException)
    await promise.catch((error: RequestException) => {
      expect(error.getStatus()).toBe(status)
      expect(error.getResponse()).toMatchObject({ code })
    })
  }

  beforeEach(async () => {
    service = {
      startTrial: jest.fn().mockResolvedValue({ data: { id: 'sub-1' } }),
      startPaid: jest.fn().mockResolvedValue({
        data: { id: 'sub-1' },
        acceptanceUrl: 'https://pay/x',
      }),
      changePlan: jest.fn().mockResolvedValue({ data: { id: 'sub-1' } }),
      cancel: jest.fn().mockResolvedValue({ data: { id: 'sub-1' } }),
      reactivate: jest.fn().mockResolvedValue({ data: { id: 'sub-1' } }),
    }
    platformClient = {
      canViewBrandCredit: jest.fn().mockImplementation(async (userId: string, brandId: string) => {
        return userId === USER_ID && (brandId === OWN_BRAND_ID || brandId === MEMBER_BRAND_ID)
      }),
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        { provide: SubscriptionService, useValue: service },
        { provide: EnterprisePricingService, useValue: {} },
        { provide: ClientPlatformService, useValue: platformClient },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    controller = moduleRef.get<SubscriptionController>(SubscriptionController)
  })

  describe('startTrial', () => {
    it('allows caller to start trial on own brand via session or brand membership', async () => {
      await controller.startTrial(
        { brandId: OWN_BRAND_ID, userId: USER_ID, planSlug: 'pro' },
        { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
      )
      expect(service.startTrial).toHaveBeenCalledWith({
        brandId: OWN_BRAND_ID,
        userId: USER_ID,
        planSlug: 'pro',
      })

      service.startTrial.mockClear()

      await controller.startTrial(
        { brandId: MEMBER_BRAND_ID, userId: USER_ID, planSlug: 'pro' },
        { user: { id: USER_ID, isSuperAdmin: false, brand: null } },
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, MEMBER_BRAND_ID)
      expect(service.startTrial).toHaveBeenCalledWith({
        brandId: MEMBER_BRAND_ID,
        userId: USER_ID,
        planSlug: 'pro',
      })
    })

    it('rejects foreign brand with 403 and does not call subscriptionService.startTrial', async () => {
      await expectWriteException(
        controller.startTrial(
          { brandId: FOREIGN_BRAND_ID, userId: USER_ID, planSlug: 'pro' },
          { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
        ),
        'forbidden',
        HttpStatus.FORBIDDEN,
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, FOREIGN_BRAND_ID)
      expect(service.startTrial).not.toHaveBeenCalled()
    })

    it('allows service token to target any brand and requires brandId', async () => {
      await controller.startTrial(
        { brandId: FOREIGN_BRAND_ID, userId: USER_ID, planSlug: 'pro' },
        { user: { ...SERVER_PRINCIPAL } },
      )
      expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
      expect(service.startTrial).toHaveBeenCalledWith({
        brandId: FOREIGN_BRAND_ID,
        userId: USER_ID,
        planSlug: 'pro',
      })

      service.startTrial.mockClear()

      await expectWriteException(
        controller.startTrial(
          { brandId: '', userId: USER_ID, planSlug: 'pro' },
          { user: { ...SERVER_PRINCIPAL } },
        ),
        'BRAND_ID_REQUIRED',
        HttpStatus.BAD_REQUEST,
      )
      expect(service.startTrial).not.toHaveBeenCalled()
    })

    it('uses req.user.id from a user session and ignores a different userId in the body while allowing the service token to specify userId', async () => {
      await controller.startTrial(
        { brandId: OWN_BRAND_ID, userId: 'other-user-id', planSlug: 'pro' },
        { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
      )
      expect(service.startTrial).toHaveBeenCalledWith({
        brandId: OWN_BRAND_ID,
        userId: USER_ID,
        planSlug: 'pro',
      })
      expect(service.startTrial).not.toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'other-user-id' }),
      )

      service.startTrial.mockClear()

      await controller.startTrial(
        { brandId: OWN_BRAND_ID, userId: 'other-user-id', planSlug: 'pro' },
        { user: { ...SERVER_PRINCIPAL } },
      )
      expect(service.startTrial).toHaveBeenCalledWith({
        brandId: OWN_BRAND_ID,
        userId: 'other-user-id',
        planSlug: 'pro',
      })
    })
  })

  describe('changePlan', () => {
    it('allows caller to change plan on own brand via session or brand membership', async () => {
      await controller.changePlan(
        { brandId: OWN_BRAND_ID, planSlug: 'enterprise', triggeredBy: USER_ID },
        { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
      )
      expect(service.changePlan).toHaveBeenCalledWith(OWN_BRAND_ID, {
        planSlug: 'enterprise',
        triggeredBy: USER_ID,
      })

      service.changePlan.mockClear()

      await controller.changePlan(
        { brandId: MEMBER_BRAND_ID, planSlug: 'enterprise', triggeredBy: USER_ID },
        { user: { id: USER_ID, isSuperAdmin: false, brand: null } },
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, MEMBER_BRAND_ID)
      expect(service.changePlan).toHaveBeenCalledWith(MEMBER_BRAND_ID, {
        planSlug: 'enterprise',
        triggeredBy: USER_ID,
      })
    })

    it('rejects foreign brand with 403 and does not call subscriptionService.changePlan', async () => {
      await expectWriteException(
        controller.changePlan(
          { brandId: FOREIGN_BRAND_ID, planSlug: 'enterprise', triggeredBy: USER_ID },
          { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
        ),
        'forbidden',
        HttpStatus.FORBIDDEN,
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, FOREIGN_BRAND_ID)
      expect(service.changePlan).not.toHaveBeenCalled()
    })

    it('allows service token to target any brand and requires brandId', async () => {
      await controller.changePlan(
        { brandId: FOREIGN_BRAND_ID, planSlug: 'enterprise', triggeredBy: 'server' },
        { user: { ...SERVER_PRINCIPAL } },
      )
      expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
      expect(service.changePlan).toHaveBeenCalledWith(FOREIGN_BRAND_ID, {
        planSlug: 'enterprise',
        triggeredBy: 'server',
      })

      service.changePlan.mockClear()

      await expectWriteException(
        controller.changePlan(
          { brandId: '', planSlug: 'enterprise', triggeredBy: 'server' },
          { user: { ...SERVER_PRINCIPAL } },
        ),
        'BRAND_ID_REQUIRED',
        HttpStatus.BAD_REQUEST,
      )
      expect(service.changePlan).not.toHaveBeenCalled()
    })
  })

  describe('cancel', () => {
    it('allows caller to cancel subscription on own brand via session or brand membership', async () => {
      await controller.cancel(
        { brandId: OWN_BRAND_ID, reason: 'closing store', triggeredBy: USER_ID },
        { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
      )
      expect(service.cancel).toHaveBeenCalledWith(OWN_BRAND_ID, {
        reason: 'closing store',
        triggeredBy: USER_ID,
      })

      service.cancel.mockClear()

      await controller.cancel(
        { brandId: MEMBER_BRAND_ID, reason: 'closing store', triggeredBy: USER_ID },
        { user: { id: USER_ID, isSuperAdmin: false, brand: null } },
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, MEMBER_BRAND_ID)
      expect(service.cancel).toHaveBeenCalledWith(MEMBER_BRAND_ID, {
        reason: 'closing store',
        triggeredBy: USER_ID,
      })
    })

    it('rejects foreign brand with 403 and does not call subscriptionService.cancel', async () => {
      await expectWriteException(
        controller.cancel(
          { brandId: FOREIGN_BRAND_ID, reason: 'unauthorized cancel', triggeredBy: USER_ID },
          { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
        ),
        'forbidden',
        HttpStatus.FORBIDDEN,
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, FOREIGN_BRAND_ID)
      expect(service.cancel).not.toHaveBeenCalled()
    })

    it('allows service token to target any brand and requires brandId', async () => {
      await controller.cancel(
        { brandId: FOREIGN_BRAND_ID, reason: 'admin cancel', triggeredBy: 'server' },
        { user: { ...SERVER_PRINCIPAL } },
      )
      expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
      expect(service.cancel).toHaveBeenCalledWith(FOREIGN_BRAND_ID, {
        reason: 'admin cancel',
        triggeredBy: 'server',
      })

      service.cancel.mockClear()

      await expectWriteException(
        controller.cancel(
          { brandId: '', reason: 'admin cancel', triggeredBy: 'server' },
          { user: { ...SERVER_PRINCIPAL } },
        ),
        'BRAND_ID_REQUIRED',
        HttpStatus.BAD_REQUEST,
      )
      expect(service.cancel).not.toHaveBeenCalled()
    })
  })

  describe('reactivate', () => {
    it('allows caller to reactivate subscription on own brand via session or brand membership', async () => {
      await controller.reactivate(
        { brandId: OWN_BRAND_ID, triggeredBy: USER_ID },
        { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
      )
      expect(service.reactivate).toHaveBeenCalledWith(OWN_BRAND_ID, USER_ID)

      service.reactivate.mockClear()

      await controller.reactivate(
        { brandId: MEMBER_BRAND_ID, triggeredBy: USER_ID },
        { user: { id: USER_ID, isSuperAdmin: false, brand: null } },
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, MEMBER_BRAND_ID)
      expect(service.reactivate).toHaveBeenCalledWith(MEMBER_BRAND_ID, USER_ID)
    })

    it('rejects foreign brand with 403 and does not call subscriptionService.reactivate', async () => {
      await expectWriteException(
        controller.reactivate(
          { brandId: FOREIGN_BRAND_ID, triggeredBy: USER_ID },
          { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
        ),
        'forbidden',
        HttpStatus.FORBIDDEN,
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, FOREIGN_BRAND_ID)
      expect(service.reactivate).not.toHaveBeenCalled()
    })

    it('allows service token to target any brand and requires brandId', async () => {
      await controller.reactivate(
        { brandId: FOREIGN_BRAND_ID, triggeredBy: 'server' },
        { user: { ...SERVER_PRINCIPAL } },
      )
      expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
      expect(service.reactivate).toHaveBeenCalledWith(FOREIGN_BRAND_ID, 'server')

      service.reactivate.mockClear()

      await expectWriteException(
        controller.reactivate(
          { brandId: '', triggeredBy: 'server' },
          { user: { ...SERVER_PRINCIPAL } },
        ),
        'BRAND_ID_REQUIRED',
        HttpStatus.BAD_REQUEST,
      )
      expect(service.reactivate).not.toHaveBeenCalled()
    })
  })

  describe('startPaid', () => {
    it('allows caller to start paid subscription on own brand via session or brand membership', async () => {
      await controller.startPaid(
        { brandId: OWN_BRAND_ID, userId: USER_ID, planSlug: 'dropi-roax' },
        { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
      )
      expect(service.startPaid).toHaveBeenCalledWith({
        brandId: OWN_BRAND_ID,
        userId: USER_ID,
        planSlug: 'dropi-roax',
      })

      service.startPaid.mockClear()

      await controller.startPaid(
        { brandId: MEMBER_BRAND_ID, userId: USER_ID, planSlug: 'dropi-roax' },
        { user: { id: USER_ID, isSuperAdmin: false, brand: null } },
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, MEMBER_BRAND_ID)
      expect(service.startPaid).toHaveBeenCalledWith({
        brandId: MEMBER_BRAND_ID,
        userId: USER_ID,
        planSlug: 'dropi-roax',
      })
    })

    it('rejects foreign brand with 403 and does not call subscriptionService.startPaid', async () => {
      await expectWriteException(
        controller.startPaid(
          { brandId: FOREIGN_BRAND_ID, userId: USER_ID, planSlug: 'dropi-roax' },
          { user: { id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID } },
        ),
        'forbidden',
        HttpStatus.FORBIDDEN,
      )
      expect(platformClient.canViewBrandCredit).toHaveBeenCalledWith(USER_ID, FOREIGN_BRAND_ID)
      expect(service.startPaid).not.toHaveBeenCalled()
    })

    it('allows service token to target any brand and requires brandId', async () => {
      await controller.startPaid(
        { brandId: FOREIGN_BRAND_ID, userId: USER_ID, planSlug: 'dropi-roax' },
        { user: { ...SERVER_PRINCIPAL } },
      )
      expect(platformClient.canViewBrandCredit).not.toHaveBeenCalled()
      expect(service.startPaid).toHaveBeenCalledWith({
        brandId: FOREIGN_BRAND_ID,
        userId: USER_ID,
        planSlug: 'dropi-roax',
      })

      service.startPaid.mockClear()

      await expectWriteException(
        controller.startPaid(
          { brandId: '', userId: USER_ID, planSlug: 'dropi-roax' },
          { user: { ...SERVER_PRINCIPAL } },
        ),
        'BRAND_ID_REQUIRED',
        HttpStatus.BAD_REQUEST,
      )
      expect(service.startPaid).not.toHaveBeenCalled()
    })
  })
})
