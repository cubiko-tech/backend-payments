import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'

import { BillingProfileController } from '../billing-profile/billing-profile.controller'
import { BillingProfileService } from '../billing-profile/billing-profile.service'
import { LegalDocumentService } from '../billing-profile/legal-document.service'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { unknownServiceKeys } from '../../test/support/service-credential.double'
import { createGlobalValidationPipe } from '../shared/validation/global-validation-pipe'
import { EnterprisePricingService } from '../subscription/enterprise-pricing.service'
import { SubscriptionController } from '../subscription/subscription.controller'
import { SubscriptionService } from '../subscription/subscription.service'
import { Refund, RefundReason, RefundStatus } from './entities/refund.entity'
import { RefundController } from './refund.controller'
import { RefundService } from './refund.service'

const OWN_BRAND_ID = '11111111-1111-4111-8111-111111111111'
const COMPLETED_PAYMENT_ID = '22222222-2222-4222-8222-222222222222'
const REFUNDED_PAYMENT_ID = '33333333-3333-4333-8333-333333333333'
const PENDING_REFUND_PAYMENT_ID = '44444444-4444-4444-8444-444444444444'
const UNPAID_PAYMENT_ID = '66666666-6666-4666-8666-666666666666'
const DOC_ID = '55555555-5555-4555-8555-555555555555'
const USER_ID = 'user-session-115'
const SUPERADMIN_ID = 'admin-session-115'
const JWT_SECRET = 'loc115-unit-jwt-secret'
const ACCESS_SERVER = 'loc115-unit-server-secret'

describe('Refund request guards and session authorship (LOC-115)', () => {
  const envSnapshot = { ...process.env }

  let app: INestApplication
  let jwtService: JwtService
  let userToken: string
  let superAdminToken: string
  let refundWriteRepo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock; find: jest.Mock }
  let paymentReadRepo: { findOne: jest.Mock }
  let activeRefunds: Record<string, Array<Pick<Refund, 'amount' | 'status'>>> = {}
  let subscriptionService: { cancel: jest.Mock; reactivate: jest.Mock }
  let legalDocumentService: { verify: jest.Mock; reject: jest.Mock }

  beforeAll(async () => {
    process.env.JWT_SECRET = JWT_SECRET
    process.env.ACCESS_SERVER = ACCESS_SERVER
    jwtService = new JwtService({ secret: JWT_SECRET })
    userToken = jwtService.sign({ id: USER_ID, isSuperAdmin: false, brand: OWN_BRAND_ID })
    superAdminToken = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })

    // R17: unit spec for RefundService/controller branching; real locks: test/refund-and-authorship.e2e-spec.ts.
    refundWriteRepo = {
      // R17: mirrors repository.create field assignment without opening a DB connection in unit tests.
      create: jest.fn((data) => ({ ...data })),
      // R17: captures persisted refund payload; real DB write is exercised in the e2e spec.
      save: jest.fn(async (entity) => ({ id: 'ref-created-1', ...entity })),
      // R17: unused by request(); approve() reads by id.
      findOne: jest.fn(),
      // R17: returns the active refunds the case seeds per paymentId.
      find: jest.fn(),
    }
    // R17: supplies payment state and amount for unit branch isolation; real rows are queried in the e2e spec.
    paymentReadRepo = { findOne: jest.fn() }
    // R17: captures triggeredBy passed by SubscriptionController; DB event persistence is tested in the e2e spec.
    subscriptionService = {
      // R17: records cancel arguments from controller.
      cancel: jest.fn().mockResolvedValue({ data: { id: 'sub-1' } }),
      // R17: records reactivate arguments from controller.
      reactivate: jest.fn().mockResolvedValue({ data: { id: 'sub-1' } }),
    }
    // R17: captures verifiedBy passed by BillingProfileController; DB document persistence is tested in the e2e spec.
    legalDocumentService = {
      // R17: records verify arguments from controller.
      verify: jest.fn(async (id: string, verifiedBy: string) => ({
        data: { id, status: 'verified', verifiedBy },
      })),
      // R17: records reject arguments from controller.
      reject: jest.fn(async (id: string, verifiedBy: string, reason: string) => ({
        data: { id, status: 'rejected', verifiedBy, rejectionReason: reason },
      })),
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [RefundController, SubscriptionController, BillingProfileController],
      providers: [
        RefundService,
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        // R17: real JwtService instance configured with test secret.
        { provide: JwtService, useValue: jwtService },
        // R17: permission check stub; routes under test use session brand or @RequireSuperAdmin.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
        // R17: brand membership stub allowing OWN_BRAND_ID; real HTTP boundary is tested in e2e.
        {
          provide: ClientPlatformService,
          // R17: grants brand access only to OWN_BRAND_ID.
          useValue: { canViewBrandCredit: jest.fn(async (_u, b) => b === OWN_BRAND_ID) },
        },
        // R17: write repository double for Refund unit tests.
        { provide: getRepositoryToken(Refund, 'DBWrite'), useValue: refundWriteRepo },
        // R17: read repository double for RefundService constructor.
        { provide: getRepositoryToken(Refund, 'DBRead'), useValue: { findOne: jest.fn() } },
        // R17: read repository double for Payment state and amount lookup.
        { provide: getRepositoryToken(Payment, 'DBRead'), useValue: paymentReadRepo },
        // R17: subscription service double to inspect triggeredBy forwarded by SubscriptionController.
        { provide: SubscriptionService, useValue: subscriptionService },
        // R17: unused by cancel/reactivate; satisfies SubscriptionController constructor.
        { provide: EnterprisePricingService, useValue: {} },
        // R17: unused by document verify/reject; satisfies BillingProfileController constructor.
        { provide: BillingProfileService, useValue: {} },
        // R17: legal document service double to inspect verifiedBy forwarded by BillingProfileController.
        { provide: LegalDocumentService, useValue: legalDocumentService },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
    process.env = { ...envSnapshot }
  })

  beforeEach(() => {
    jest.clearAllMocks()
    paymentReadRepo.findOne.mockImplementation(async ({ where }: any) => {
      if (where?.id === COMPLETED_PAYMENT_ID) {
        return {
          id: COMPLETED_PAYMENT_ID,
          brandId: OWN_BRAND_ID,
          amount: 5000,
          currency: 'COP',
          status: PaymentStatus.COMPLETED,
        }
      }
      if (where?.id === REFUNDED_PAYMENT_ID) {
        return {
          id: REFUNDED_PAYMENT_ID,
          brandId: OWN_BRAND_ID,
          amount: 5000,
          currency: 'COP',
          status: PaymentStatus.REFUNDED,
        }
      }
      if (where?.id === PENDING_REFUND_PAYMENT_ID) {
        return {
          id: PENDING_REFUND_PAYMENT_ID,
          brandId: OWN_BRAND_ID,
          amount: 5000,
          currency: 'COP',
          status: PaymentStatus.COMPLETED,
        }
      }
      if (where?.id === UNPAID_PAYMENT_ID) {
        return {
          id: UNPAID_PAYMENT_ID,
          brandId: OWN_BRAND_ID,
          amount: 5000,
          currency: 'COP',
          status: PaymentStatus.PENDING,
        }
      }
      return null
    })
    activeRefunds = {}
    refundWriteRepo.find.mockImplementation(async ({ where }: any) => {
      if (where?.paymentId === PENDING_REFUND_PAYMENT_ID) {
        return [{ id: 'existing-pending-refund', amount: 5000, status: RefundStatus.PENDING }]
      }
      return activeRefunds[where?.paymentId] ?? []
    })
  })

  it('rejects refunding an already refunded payment with 409 PAYMENT_ALREADY_REFUNDED and creates no row', async () => {
    // R15 (Mutation): dropping the `PaymentStatus.REFUNDED` check in refund.service.ts returns 201 and calls save.
    const res = await request(app.getHttpServer())
      .post('/refund')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        paymentId: REFUNDED_PAYMENT_ID,
        amount: 5000,
        currency: 'COP',
        reason: RefundReason.CUSTOMER_REQUEST,
      })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body).toMatchObject({ code: 'PAYMENT_ALREADY_REFUNDED' })
    expect(refundWriteRepo.save).not.toHaveBeenCalled()
  })

  it('rejects a second refund when another pending refund exists for the same payment with 409 REFUND_ALREADY_PENDING', async () => {
    // R15 (Mutation): removing the `existingPending` check in refund.service.ts creates a second pending row.
    const res = await request(app.getHttpServer())
      .post('/refund')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        paymentId: PENDING_REFUND_PAYMENT_ID,
        amount: 5000,
        currency: 'COP',
        reason: RefundReason.DUPLICATE,
      })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body).toMatchObject({ code: 'REFUND_ALREADY_PENDING' })
    expect(refundWriteRepo.save).not.toHaveBeenCalled()
  })

  it('rejects a refund amount greater than the payment amount with 400 REFUND_AMOUNT_EXCEEDS_PAYMENT', async () => {
    // R15 (Mutation): flipping `Number(data.amount) > Number(payment.amount)` in refund.service.ts returns 201.
    const res = await request(app.getHttpServer())
      .post('/refund')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        paymentId: COMPLETED_PAYMENT_ID,
        amount: 999999,
        currency: 'COP',
        reason: RefundReason.CUSTOMER_REQUEST,
      })

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body).toMatchObject({ code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT' })
    expect(refundWriteRepo.save).not.toHaveBeenCalled()
  })

  const postRefund = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/refund')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currency: 'COP', reason: RefundReason.CUSTOMER_REQUEST, ...body })

  it('rejects a refund on a payment that is not completed with 409 PAYMENT_NOT_COMPLETED', async () => {
    // R15 (Mutation): guarding only `PaymentStatus.REFUNDED` in refund.service.ts lets a pending payment through.
    const res = await postRefund({ paymentId: UNPAID_PAYMENT_ID, amount: 1000 })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body).toMatchObject({ code: 'PAYMENT_NOT_COMPLETED' })
    expect(refundWriteRepo.save).not.toHaveBeenCalled()
  })

  it('rejects a refund whose currency differs from the payment with 400 REFUND_CURRENCY_MISMATCH', async () => {
    // R15 (Mutation): removing the currency comparison in refund.service.ts creates a USD refund on a COP payment.
    const res = await postRefund({ paymentId: COMPLETED_PAYMENT_ID, amount: 10, currency: 'USD' })

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body).toMatchObject({ code: 'REFUND_CURRENCY_MISMATCH' })
    expect(refundWriteRepo.save).not.toHaveBeenCalled()
  })

  it('rejects 1000 more on a 5000 payment already refunded in full with 400 REFUND_AMOUNT_EXCEEDS_PAYMENT', async () => {
    // R15 (Mutation): capping only the requested amount in refund.service.ts returns 201 and saves.
    // Prepares for executed refunds: nothing reaches `completed` yet, the e2e covers `processing`.
    activeRefunds[COMPLETED_PAYMENT_ID] = [
      { amount: '5000.00' as any, status: RefundStatus.COMPLETED },
    ]

    const res = await postRefund({ paymentId: COMPLETED_PAYMENT_ID, amount: 1000 })

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body).toMatchObject({ code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT' })
    expect(refundWriteRepo.save).not.toHaveBeenCalled()
  })

  it('rejects a refund while another one is processing under the cap with 409 REFUND_ALREADY_PENDING', async () => {
    // R15 (Mutation): dropping `processing` from the in-flight check in refund.service.ts returns 201.
    activeRefunds[COMPLETED_PAYMENT_ID] = [
      { amount: '1000.00' as any, status: RefundStatus.PROCESSING },
    ]

    const res = await postRefund({ paymentId: COMPLETED_PAYMENT_ID, amount: 1000 })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body).toMatchObject({ code: 'REFUND_ALREADY_PENDING' })
    expect(refundWriteRepo.save).not.toHaveBeenCalled()
  })

  it('ignores body.requestedBy and records the session user on POST /refund even when requestedBy is omitted', async () => {
    // R15 (Mutation): dropping `requestedBy: req?.user?.id` in refund.controller.ts saves `admin:falso` from the body.
    const spoofedRes = await request(app.getHttpServer())
      .post('/refund')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        paymentId: COMPLETED_PAYMENT_ID,
        amount: 5000,
        currency: 'COP',
        reason: RefundReason.CUSTOMER_REQUEST,
        requestedBy: 'admin:falso',
      })

    expect(spoofedRes.status).toBe(HttpStatus.CREATED)
    expect(spoofedRes.body.data.requestedBy).toBe(USER_ID)

    const omittedRes = await request(app.getHttpServer())
      .post('/refund')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        paymentId: COMPLETED_PAYMENT_ID,
        amount: 5000,
        currency: 'COP',
        reason: RefundReason.CUSTOMER_REQUEST,
      })

    expect(omittedRes.status).toBe(HttpStatus.CREATED)
    expect(omittedRes.body.data.requestedBy).toBe(USER_ID)
  })

  it('ignores body.triggeredBy on POST /subscription/cancel and POST /subscription/reactivate and uses session user id', async () => {
    // R15 (Mutation): restoring `data.triggeredBy` in subscription.controller.ts forwards `admin:falso`.
    const cancelRes = await request(app.getHttpServer())
      .post('/subscription/cancel')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        brandId: OWN_BRAND_ID,
        reason: 'no longer needed',
        triggeredBy: 'admin:falso',
      })

    expect(cancelRes.status).toBe(HttpStatus.CREATED)
    expect(subscriptionService.cancel).toHaveBeenCalledWith(OWN_BRAND_ID, {
      reason: 'no longer needed',
      triggeredBy: USER_ID,
    })

    const reactivateRes = await request(app.getHttpServer())
      .post('/subscription/reactivate')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        brandId: OWN_BRAND_ID,
        triggeredBy: 'admin:falso',
      })

    expect(reactivateRes.status).toBe(HttpStatus.CREATED)
    expect(subscriptionService.reactivate).toHaveBeenCalledWith(OWN_BRAND_ID, USER_ID)
  })

  it('ignores body.verifiedBy on admin document verify and reject routes and uses session user id', async () => {
    // R15 (Mutation): restoring `data.verifiedBy` in billing-profile.controller.ts forwards `admin:falso`.
    const verifyRes = await request(app.getHttpServer())
      .post(`/billing-profile/admin/documents/${DOC_ID}/verify`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ verifiedBy: 'admin:falso' })

    expect(verifyRes.status).toBe(HttpStatus.CREATED)
    expect(legalDocumentService.verify).toHaveBeenCalledWith(DOC_ID, SUPERADMIN_ID)

    const rejectRes = await request(app.getHttpServer())
      .post(`/billing-profile/admin/documents/${DOC_ID}/reject`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ verifiedBy: 'admin:falso', reason: 'expired document' })

    expect(rejectRes.status).toBe(HttpStatus.CREATED)
    expect(legalDocumentService.reject).toHaveBeenCalledWith(
      DOC_ID,
      SUPERADMIN_ID,
      'expired document',
    )
  })
})
