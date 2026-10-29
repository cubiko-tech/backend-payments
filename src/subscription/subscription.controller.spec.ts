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

/**
 * Los CUATRO endpoints que resuelven la marca del principal van en una sola tabla a
 * propósito: la regla de resolución es una, y si mañana se agrega otro que se saltee
 * `resolveBrandId`, el que lo agregue tiene que sumarlo acá o el spec deja de cubrir
 * el endpoint nuevo de forma visible.
 *
 * `confirm` es el único que ESCRIBE —puede dejar la fila viva y asignar el plan en
 * roles—, y por eso está acá y no aparte: que escriba lo hace MÁS importante, no
 * menos, que la marca no salga nunca del query de un usuario.
 */
const READS = [['getCurrent'], ['getAcceptanceLink'], ['getHistory'], ['confirm']] as const

const SERVER_PRINCIPAL = { id: 'server', isSuperAdmin: true, brand: null }
const USER_WITH_BRAND = { id: 'u1', isSuperAdmin: false, brand: 'A' }
const USER_WITHOUT_BRAND = { id: 'u1', isSuperAdmin: false, brand: null }

describe('SubscriptionController — marca del principal en las lecturas', () => {
  let controller: SubscriptionController
  let service: Record<string, jest.Mock>

  /**
   * Se afirma sobre el `code` y el status, NUNCA sobre el texto del mensaje: el
   * cuerpo es lo que ve el cliente y el campo estable del contrato es `code`.
   */
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
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SubscriptionController],
      providers: [
        {
          provide: SubscriptionService,
          useValue: {
            getCurrent: jest.fn().mockResolvedValue({ data: {} }),
            getAcceptanceLink: jest.fn().mockResolvedValue({ data: {} }),
            getHistory: jest.fn().mockResolvedValue({ data: [] }),
            confirm: jest.fn().mockResolvedValue({ data: {}, confirmed: false }),
          },
        },
        { provide: EnterprisePricingService, useValue: {} },
        { provide: ClientPlatformService, useValue: { canViewBrandCredit: jest.fn() } },
      ],
    })
      // El controller está detrás de `ApiAuthGuard`, que inyecta `JwtService` y
      // `ClientRolesService`. Este spec prueba la LÓGICA del controller —de dónde
      // sale el `brandId` con el que se llama al servicio—, no la autenticación:
      // eso vive en `shared/auth/api-auth.guard.spec.ts`. Sin el override Nest
      // falla al resolver `JwtService` en el módulo de test.
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    controller = module.get<SubscriptionController>(SubscriptionController)
    service = module.get(SubscriptionService)
  })

  it.each(READS)(
    '%s: el principal de servicio sí puede nombrar la marca por query',
    async (method) => {
      await controller[method]('B', { user: { ...SERVER_PRINCIPAL } })

      expect(service[method]).toHaveBeenCalledWith('B')
    },
  )

  it.each(READS)(
    '%s: el principal de servicio sin brandId da 400 y no consulta',
    async (method) => {
      await expectRequestException(
        controller[method](undefined as unknown as string, { user: { ...SERVER_PRINCIPAL } }),
        'BRAND_ID_REQUIRED',
        HttpStatus.BAD_REQUEST,
      )

      expect(service[method]).not.toHaveBeenCalled()
    },
  )

  it.each(READS)('%s: al usuario se le lee SU marca y el query se ignora', async (method) => {
    await controller[method]('B', { user: { ...USER_WITH_BRAND } })

    expect(service[method]).toHaveBeenCalledWith('A')
    // Esta segunda aserción es la que rompe la mutación (volver el handler a
    // `this.subscriptionService.X(brandId)`): sin ella, un handler que pasara la
    // marca del query igual podría verse verde si alguien relajara la primera.
    expect(service[method]).not.toHaveBeenCalledWith('B')
  })

  it.each(READS)('%s: el usuario sin marca da 403 forbidden y no consulta', async (method) => {
    await expectRequestException(
      controller[method]('B', { user: { ...USER_WITHOUT_BRAND } }),
      'forbidden',
      HttpStatus.FORBIDDEN,
    )

    expect(service[method]).not.toHaveBeenCalled()
  })
})

/**
 * `POST /subscription/paid` es una ESCRITURA, y como el resto de las escrituras del
 * controller recibe la marca por body — `resolveBrandId` es de las tres lecturas y el
 * docblock del controller lo dice—. Este spec fija lo único que sí es de esta tarea:
 * que el handler pase el body validado tal cual, sin completar ni reinterpretar nada.
 */
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

    const result = await controller.startPaid(body)

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
        { provide: SubscriptionService, useValue: {} },
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
  })
})
