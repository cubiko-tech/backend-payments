import { HttpStatus, INestApplication, ValidationPipe } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { Payment } from '../payment/entities/payment.entity'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { Refund, RefundReason, RefundStatus } from './entities/refund.entity'
import { RefundController } from './refund.controller'
import { RefundService } from './refund.service'

describe('RefundController and RefundService brand payment ownership and operator approval (LOC-51)', () => {
  const OWN_BRAND_ID = '11111111-1111-4111-8111-111111111111'
  const FOREIGN_BRAND_ID = '22222222-2222-4222-8222-222222222222'
  const OWN_PAYMENT_ID = '33333333-3333-4333-8333-333333333333'
  const FOREIGN_PAYMENT_ID = '44444444-4444-4444-8444-444444444444'
  const PENDING_REFUND_ID = '55555555-5555-4555-8555-555555555555'
  const NON_EXISTENT_REFUND_ID = '99999999-9999-4999-8999-999999999999'
  const USER_ID = '66666666-6666-4666-8666-666666666666'
  const SUPERADMIN_ID = '77777777-7777-4777-8777-777777777777'
  const JWT_SECRET = 'loc51-test-jwt-secret'
  const SERVER_SECRET = 'loc51-test-server-secret'

  let app: INestApplication
  let jwtService: JwtService
  let userToken: string
  let superAdminToken: string
  let prevJwtSecret: string | undefined
  let prevAccessServer: string | undefined

  let refundWriteRepo: {
    create: jest.Mock
    save: jest.Mock
    findOne: jest.Mock
  }
  let refundReadRepo: {
    findAndCount: jest.Mock
    findOne: jest.Mock
  }
  let paymentReadRepo: {
    findOne: jest.Mock
  }
  let platformClient: {
    canViewBrandCredit: jest.Mock
  }
  let rolesService: {
    checkPermission: jest.Mock
  }

  beforeAll(async () => {
    prevJwtSecret = process.env.JWT_SECRET
    prevAccessServer = process.env.ACCESS_SERVER
    process.env.JWT_SECRET = JWT_SECRET
    process.env.ACCESS_SERVER = SERVER_SECRET

    jwtService = new JwtService({ secret: JWT_SECRET })
    userToken = jwtService.sign({ id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID })
    superAdminToken = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })

    refundWriteRepo = {
      create: jest.fn((data) => ({ ...data })),
      save: jest.fn(async (entity) => ({
        id: entity.id ?? PENDING_REFUND_ID,
        ...entity,
      })),
      findOne: jest.fn(),
    }
    refundReadRepo = {
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      findOne: jest.fn(),
    }
    paymentReadRepo = {
      findOne: jest.fn(),
    }
    platformClient = {
      canViewBrandCredit: jest.fn(async (_userId: string, brandId: string) => {
        return brandId === OWN_BRAND_ID
      }),
    }
    rolesService = {
      checkPermission: jest.fn().mockResolvedValue(false),
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [RefundController],
      providers: [
        RefundService,
        Reflector,
        ApiAuthGuard,
        { provide: JwtService, useValue: jwtService },
        { provide: ClientRolesService, useValue: rolesService },
        { provide: ClientPlatformService, useValue: platformClient },
        { provide: getRepositoryToken(Refund, 'DBWrite'), useValue: refundWriteRepo },
        { provide: getRepositoryToken(Refund, 'DBRead'), useValue: refundReadRepo },
        { provide: getRepositoryToken(Payment, 'DBRead'), useValue: paymentReadRepo },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    await app.init()
  })

  afterAll(async () => {
    await app.close()
    if (prevJwtSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = prevJwtSecret
    if (prevAccessServer === undefined) delete process.env.ACCESS_SERVER
    else process.env.ACCESS_SERVER = prevAccessServer
  })

  beforeEach(() => {
    jest.clearAllMocks()

    paymentReadRepo.findOne.mockImplementation(async ({ where }: any) => {
      if (where?.id === OWN_PAYMENT_ID) {
        return { id: OWN_PAYMENT_ID, brandId: OWN_BRAND_ID }
      }
      if (where?.id === FOREIGN_PAYMENT_ID) {
        return { id: FOREIGN_PAYMENT_ID, brandId: FOREIGN_BRAND_ID }
      }
      return null
    })

    refundWriteRepo.findOne.mockImplementation(async ({ where }: any) => {
      if (where?.id === PENDING_REFUND_ID) {
        return {
          id: PENDING_REFUND_ID,
          brandId: OWN_BRAND_ID,
          paymentId: OWN_PAYMENT_ID,
          amount: 50,
          currency: 'COP',
          reason: RefundReason.CUSTOMER_REQUEST,
          status: RefundStatus.PENDING,
          approvedBy: null,
        }
      }
      return null
    })
  })

  it('rejects requesting a refund for a payment belonging to another brand with 403 and creates no refund', async () => {
    const res = await request(app.getHttpServer())
      .post('/refund')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        paymentId: FOREIGN_PAYMENT_ID,
        amount: 50,
        currency: 'COP',
        reason: RefundReason.CUSTOMER_REQUEST,
      })

    expect(res.status).toBe(HttpStatus.FORBIDDEN)
    expect(paymentReadRepo.findOne).toHaveBeenCalledWith({ where: { id: FOREIGN_PAYMENT_ID } })
    expect(refundWriteRepo.create).not.toHaveBeenCalled()
    expect(refundWriteRepo.save).not.toHaveBeenCalled()
  })

  it('creates a pending refund when the payment belongs to the caller brand', async () => {
    const res = await request(app.getHttpServer())
      .post('/refund')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        paymentId: OWN_PAYMENT_ID,
        amount: 50,
        currency: 'COP',
        reason: RefundReason.CUSTOMER_REQUEST,
      })

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(paymentReadRepo.findOne).toHaveBeenCalledWith({ where: { id: OWN_PAYMENT_ID } })
    expect(refundWriteRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: OWN_BRAND_ID,
        paymentId: OWN_PAYMENT_ID,
        status: RefundStatus.PENDING,
      }),
    )
    expect(refundWriteRepo.save).toHaveBeenCalledTimes(1)
  })

  it('rejects POST /refund/:id/approve with 403 for a non-superadmin user even on a non-existent refund id', async () => {
    const nonExistentRes = await request(app.getHttpServer())
      .post(`/refund/${NON_EXISTENT_REFUND_ID}/approve`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ approvedBy: USER_ID })

    expect(nonExistentRes.status).toBe(HttpStatus.FORBIDDEN)
    expect(refundWriteRepo.findOne).not.toHaveBeenCalled()
    expect(refundWriteRepo.save).not.toHaveBeenCalled()

    const existingRes = await request(app.getHttpServer())
      .post(`/refund/${PENDING_REFUND_ID}/approve`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ approvedBy: USER_ID })

    expect(existingRes.status).toBe(HttpStatus.FORBIDDEN)
    expect(refundWriteRepo.findOne).not.toHaveBeenCalled()
    expect(refundWriteRepo.save).not.toHaveBeenCalled()
  })

  it('approves a pending refund for superadmin and service token using session user id and ignoring body.approvedBy', async () => {
    const superAdminRes = await request(app.getHttpServer())
      .post(`/refund/${PENDING_REFUND_ID}/approve`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ approvedBy: 'otro' })

    expect(superAdminRes.status).toBe(HttpStatus.CREATED)
    expect(superAdminRes.body.data).toEqual(
      expect.objectContaining({
        id: PENDING_REFUND_ID,
        status: RefundStatus.PROCESSING,
        approvedBy: SUPERADMIN_ID,
      }),
    )
    expect(refundWriteRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: PENDING_REFUND_ID,
        status: RefundStatus.PROCESSING,
        approvedBy: SUPERADMIN_ID,
      }),
    )

    refundWriteRepo.save.mockClear()

    const serverRes = await request(app.getHttpServer())
      .post(`/refund/${PENDING_REFUND_ID}/approve`)
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({ approvedBy: 'otro' })

    expect(serverRes.status).toBe(HttpStatus.CREATED)
    expect(serverRes.body.data).toEqual(
      expect.objectContaining({
        id: PENDING_REFUND_ID,
        status: RefundStatus.PROCESSING,
        approvedBy: 'server',
      }),
    )
  })
})
