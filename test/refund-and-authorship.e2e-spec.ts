// R6: Keeps all refund guards and session authorship e2e cases against PostgreSQL in one suite.
import { HttpStatus, INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import * as cookieParser from 'cookie-parser'
import * as request from 'supertest'
import { DataSource, Repository } from 'typeorm'

import { AdminController } from '../src/admin/admin.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { BillingProfileController } from '../src/billing-profile/billing-profile.controller'
import { BillingProfileService } from '../src/billing-profile/billing-profile.service'
import {
  BrandLegalDocument,
  DocumentStatus,
} from '../src/billing-profile/entities/brandLegalDocument.entity'
import { LegalDocumentService } from '../src/billing-profile/legal-document.service'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { ClientRolesService } from '../src/client/client-roles.service'
import { CreditService } from '../src/credit/credit.service'
import { EventBusService } from '../src/event-bus/event-bus.service'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { ProviderConfig } from '../src/provider/entities/providerConfig.entity'
import { Refund, RefundReason, RefundStatus } from '../src/refund/entities/refund.entity'
import { RefundController } from '../src/refund/refund.controller'
import { RefundService } from '../src/refund/refund.service'
import { ApiAuthGuard } from '../src/shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../src/shared/validation/global-validation-pipe'
import { ConfioCancellationService } from '../src/subscription/confio-cancellation.service'
import { ConfioTrialService } from '../src/subscription/confio-trial.service'
import { EnterprisePricingService } from '../src/subscription/enterprise-pricing.service'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../src/subscription/entities/subscription.entity'
import {
  SubscriptionEvent,
  SubscriptionEventType,
} from '../src/subscription/entities/subscriptionEvent.entity'
import { SubscriptionController } from '../src/subscription/subscription.controller'
import { SubscriptionService } from '../src/subscription/subscription.service'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet } from '../src/wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../src/wallet/entities/walletBalanceSnapshot.entity'
import { TokenWalletService } from '../src/wallet/token-wallet.service'
import { WalletService } from '../src/wallet/wallet.service'
import { ConfioSubscriptionWebhookService } from '../src/webhook/confio-subscription-webhook.service'
import { unknownServiceKeys } from './support/service-credential.double'

const [BRAND_A, USER_A, SUPERADMIN_ID] = [
  'a1150001-1111-4111-8111-111111111111',
  'user-owner-loc115',
  'superadmin-loc115',
]
const [COOKIE_NAME, JWT_SECRET, ACCESS_SERVER] = [
  'cubiko-wt-lg',
  'e2e-loc115-jwt-secret',
  'e2e-loc115-server-token',
]

describe('Refund guards and session authorship (PostgreSQL, LOC-115)', () => {
  const envSnapshot = { ...process.env }

  let app: INestApplication
  let dataSource: DataSource
  let jwtService: JwtService
  let paymentRepo: Repository<Payment>
  let refundRepo: Repository<Refund>
  let subRepo: Repository<Subscription>
  let subEventRepo: Repository<SubscriptionEvent>
  let docRepo: Repository<BrandLegalDocument>
  let [userToken, superAdminToken] = ['', '']

  const cleanBrand = async () => {
    if (!dataSource?.isInitialized) return
    for (const sql of [
      'DELETE FROM audit_log WHERE "entityType" = \'wallet\' AND "entityId" IN (SELECT id::text FROM wallets WHERE "brandId" = $1)',
      'DELETE FROM transactions WHERE "brandId" = $1',
      'DELETE FROM wallets WHERE "brandId" = $1',
      'DELETE FROM subscription_events WHERE "subscriptionId" IN (SELECT id FROM subscriptions WHERE "brandId" = $1)',
      'DELETE FROM subscriptions WHERE "brandId" = $1',
      'DELETE FROM refunds WHERE "brandId" = $1',
      'DELETE FROM payments WHERE "brandId" = $1',
      'DELETE FROM brand_legal_documents WHERE "brandId" = $1',
    ])
      await dataSource.query(sql, [BRAND_A])
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER, COOKIE_SESSION: COOKIE_NAME })

    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST || '127.0.0.1',
      port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
      username: process.env.POSTGRES_USER || 'postgres',
      password: process.env.POSTGRES_PASSWORD || 'postgres',
      database: process.env.POSTGRES_DB,
      entities: [
        Payment,
        Refund,
        Subscription,
        SubscriptionEvent,
        BrandLegalDocument,
        Wallet,
        WalletBalanceSnapshot,
        ProviderConfig,
        Transaction,
        AuditLog,
      ],
      synchronize: false,
    })
    await dataSource.initialize()
    paymentRepo = dataSource.getRepository(Payment)
    refundRepo = dataSource.getRepository(Refund)
    subRepo = dataSource.getRepository(Subscription)
    subEventRepo = dataSource.getRepository(SubscriptionEvent)
    docRepo = dataSource.getRepository(BrandLegalDocument)

    jwtService = new JwtService({ secret: JWT_SECRET })
    userToken = jwtService.sign({ id: USER_A, isSuperAdmin: false, brand: BRAND_A })
    superAdminToken = jwtService.sign({ id: SUPERADMIN_ID, isSuperAdmin: true, brand: null })

    const provideRepo = (entity: any, conn = 'DBWrite') => ({
      provide: getRepositoryToken(entity, conn),
      useValue: dataSource.getRepository(entity),
    })

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [
        RefundController,
        SubscriptionController,
        BillingProfileController,
        AdminController,
      ],
      providers: [
        RefundService,
        SubscriptionService,
        LegalDocumentService,
        AuditService,
        Reflector,
        ApiAuthGuard,
        unknownServiceKeys,
        { provide: JwtService, useValue: jwtService },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        provideRepo(Refund, 'DBWrite'),
        provideRepo(Refund, 'DBRead'),
        provideRepo(Payment, 'DBWrite'),
        provideRepo(Payment, 'DBRead'),
        provideRepo(Subscription, 'DBWrite'),
        provideRepo(Subscription, 'DBRead'),
        provideRepo(SubscriptionEvent, 'DBWrite'),
        provideRepo(SubscriptionEvent, 'DBRead'),
        provideRepo(BrandLegalDocument, 'DBWrite'),
        provideRepo(BrandLegalDocument, 'DBRead'),
        provideRepo(Wallet, 'DBWrite'),
        provideRepo(Wallet, 'DBRead'),
        provideRepo(WalletBalanceSnapshot, 'DBRead'),
        provideRepo(ProviderConfig, 'DBWrite'),
        provideRepo(ProviderConfig, 'DBRead'),
        provideRepo(Transaction, 'DBWrite'),
        provideRepo(Transaction, 'DBRead'),
        WalletService,
        TokenWalletService,
        provideRepo(AuditLog, 'DBWrite'),
        provideRepo(AuditLog, 'DBRead'),
        // R17: unused by admin wallet endpoints; satisfies AdminController constructor.
        { provide: CreditService, useValue: {} },
        // R17: HTTP to backend-platform is out of scope; brand ownership comes from the session claim and stub.
        {
          provide: ClientPlatformService,
          // R17: allows BRAND_A membership without calling external backend-platform HTTP.
          useValue: { canViewBrandCredit: jest.fn(async (_u, b) => b === BRAND_A) },
        },
        // R17: routes under test use session brand or @RequireSuperAdmin, not granular roles permissions.
        { provide: ClientRolesService, useValue: { checkPermission: jest.fn() } },
        // R17: Redis Stream notifications are not exercised by cancel/reactivate/refund.
        { provide: EventBusService, useValue: { publishNotification: jest.fn() } },
        // R17: unused by cancel/reactivate on wallet subscriptions.
        { provide: ConfioTrialService, useValue: {} },
        // R17: unused by wallet subscription cancel/reactivate.
        { provide: ConfioCancellationService, useValue: { cancel: jest.fn() } },
        // R17: unused by cancel/reactivate.
        { provide: ConfioSubscriptionWebhookService, useValue: {} },
        // R17: unused by cancel/reactivate; satisfies SubscriptionController constructor.
        { provide: EnterprisePricingService, useValue: {} },
        // R17: unused by legal document verification; satisfies BillingProfileController constructor.
        { provide: BillingProfileService, useValue: {} },
      ],
    }).compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('v1')
    app.useGlobalPipes(createGlobalValidationPipe())
    app.use(cookieParser(JWT_SECRET))
    await app.init()
  })

  afterAll(async () => {
    await cleanBrand()
    await app?.close()
    if (dataSource?.isInitialized) await dataSource.destroy()
    process.env = { ...envSnapshot }
  })

  beforeEach(async () => {
    await cleanBrand()
  })

  const seedPayment = (overrides: Partial<Payment> = {}) =>
    paymentRepo.save(
      paymentRepo.create({
        brandId: BRAND_A,
        userId: USER_A,
        provider: PaymentProvider.WALLET,
        amount: 5000,
        currency: 'COP',
        status: PaymentStatus.COMPLETED,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: 'pro',
        ...overrides,
      }),
    )

  const postRefund = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/v1/refund')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currency: 'COP', reason: RefundReason.CUSTOMER_REQUEST, ...body })

  it('rejects refunding a refunded payment with 409 PAYMENT_ALREADY_REFUNDED and writes no refund row', async () => {
    // R15 (Mutation): dropping the `PaymentStatus.REFUNDED` check in refund.service.ts inserts a pending row.
    const payment = await seedPayment({ status: PaymentStatus.REFUNDED })

    const res = await postRefund({ paymentId: payment.id, amount: 5000 })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body).toMatchObject({ code: 'PAYMENT_ALREADY_REFUNDED' })
    expect(await refundRepo.count({ where: { paymentId: payment.id } })).toBe(0)
  })

  it('rejects a second refund on a payment that already has a pending refund with 409 REFUND_ALREADY_PENDING', async () => {
    // R15 (Mutation): removing the `existingPending` guard in refund.service.ts creates a second row.
    const payment = await seedPayment({ status: PaymentStatus.COMPLETED, amount: 5000 })

    const first = await postRefund({ paymentId: payment.id, amount: 5000 })
    expect(first.status).toBe(HttpStatus.CREATED)

    const second = await postRefund({
      paymentId: payment.id,
      amount: 5000,
      reason: RefundReason.DUPLICATE,
    })
    expect(second.status).toBe(HttpStatus.CONFLICT)
    expect(second.body).toMatchObject({ code: 'REFUND_ALREADY_PENDING' })

    const rows = await refundRepo.find({ where: { paymentId: payment.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe(RefundStatus.PENDING)
  })

  it('serializes two concurrent refund requests on the same payment so only one pending row is created', async () => {
    // R15 (Mutation): dropping the pessimistic_write lock on Payment in refund.service.ts inserts two rows.
    const payment = await seedPayment({ status: PaymentStatus.COMPLETED, amount: 5000 })

    const [resA, resB] = await Promise.all([
      postRefund({ paymentId: payment.id, amount: 5000 }),
      postRefund({ paymentId: payment.id, amount: 5000, reason: RefundReason.DUPLICATE }),
    ])

    const statuses = [resA.status, resB.status].sort()
    expect(statuses).toEqual([HttpStatus.CREATED, HttpStatus.CONFLICT])
    expect(await refundRepo.count({ where: { paymentId: payment.id } })).toBe(1)
  })

  it('rejects a refund amount exceeding the payment amount with 400 REFUND_AMOUNT_EXCEEDS_PAYMENT and writes no row', async () => {
    // R15 (Mutation): removing `Number(data.amount) > Number(payment.amount)` in refund.service.ts inserts a row.
    const payment = await seedPayment({ status: PaymentStatus.COMPLETED, amount: 5000 })

    const res = await postRefund({ paymentId: payment.id, amount: 999999 })

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body).toMatchObject({ code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT' })
    expect(await refundRepo.count({ where: { paymentId: payment.id } })).toBe(0)
  })

  const requestAndApprove = async (paymentId: string, amount: number) => {
    const created = await postRefund({ paymentId, amount })
    expect(created.status).toBe(HttpStatus.CREATED)
    const approved = await request(app.getHttpServer())
      .post(`/v1/refund/${created.body.data.id}/approve`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({})
    expect(approved.status).toBe(HttpStatus.CREATED)
  }

  it('rejects 1000 more on a 5000 payment with 5000 approved with 400 and keeps a single refund row', async () => {
    // R15 (Mutation): capping only the requested amount in refund.service.ts answers 409, not the 400 cap.
    const payment = await seedPayment({ status: PaymentStatus.COMPLETED, amount: 5000 })
    await requestAndApprove(payment.id, 5000)

    const res = await postRefund({ paymentId: payment.id, amount: 1000 })

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(res.body).toMatchObject({ code: 'REFUND_AMOUNT_EXCEEDS_PAYMENT' })
    expect(await refundRepo.count({ where: { paymentId: payment.id } })).toBe(1)
  })

  it('rejects a refund on a pending payment with 409 PAYMENT_NOT_COMPLETED and writes no row', async () => {
    // R15 (Mutation): guarding only `PaymentStatus.REFUNDED` in refund.service.ts inserts a pending row.
    const payment = await seedPayment({ status: PaymentStatus.PENDING, amount: 5000 })

    const res = await postRefund({ paymentId: payment.id, amount: 1000 })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body).toMatchObject({ code: 'PAYMENT_NOT_COMPLETED' })
    expect(await refundRepo.count({ where: { paymentId: payment.id } })).toBe(0)
  })

  const seedDropiRecharge = () =>
    seedPayment({ provider: PaymentProvider.DROPI_WALLET, purpose: PaymentPurpose.TOKEN_RECHARGE })

  it('rejects refunding a charged Dropi recharge with 409 PAYMENT_NOT_REFUNDABLE and writes no row', async () => {
    // R15: red when the dropi_wallet refusal goes from createPendingRefund: it answers 201.
    const payment = await seedDropiRecharge()

    const res = await postRefund({ paymentId: payment.id, amount: 5000 })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body).toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' })
    expect(await refundRepo.count({ where: { paymentId: payment.id } })).toBe(0)
  })

  it('refuses approving a pending refund of a Dropi recharge with 409 and keeps it pending', async () => {
    // R15: red when the refusal goes from approvePending: the refund ends up processing.
    const payment = await seedDropiRecharge()
    const pending = await refundRepo.save(
      refundRepo.create({
        brandId: BRAND_A,
        paymentId: payment.id,
        amount: 5000,
        currency: 'COP',
        reason: RefundReason.CUSTOMER_REQUEST,
        requestedBy: USER_A,
        status: RefundStatus.PENDING,
      }),
    )

    const res = await request(app.getHttpServer())
      .post(`/v1/refund/${pending.id}/approve`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({})

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body).toMatchObject({ code: 'PAYMENT_NOT_REFUNDABLE' })
    expect((await refundRepo.findOneByOrFail({ id: pending.id })).status).toBe(RefundStatus.PENDING)
  })

  it('rejects a refund while an approved one is processing under the cap with 409 REFUND_ALREADY_PENDING', async () => {
    // R15 (Mutation): dropping the `processing` in-flight check in refund.service.ts inserts a second row.
    const payment = await seedPayment({ status: PaymentStatus.COMPLETED, amount: 5000 })
    await requestAndApprove(payment.id, 1000)

    const res = await postRefund({ paymentId: payment.id, amount: 1000 })

    expect(res.status).toBe(HttpStatus.CONFLICT)
    expect(res.body).toMatchObject({ code: 'REFUND_ALREADY_PENDING' })
    const rows = await refundRepo.find({ where: { paymentId: payment.id } })
    expect(rows.map((r) => r.status)).toEqual([RefundStatus.PROCESSING])
  })

  it('persists requestedBy from the session on POST /v1/refund both when requestedBy is spoofed and when omitted', async () => {
    // R15 (Mutation): removing `requestedBy: req?.user?.id` in refund.controller.ts stores `admin:falso` or fails.
    const paymentA = await seedPayment({ status: PaymentStatus.COMPLETED, amount: 5000 })
    const paymentB = await seedPayment({ status: PaymentStatus.COMPLETED, amount: 5000 })

    const spoofed = await postRefund({
      paymentId: paymentA.id,
      amount: 5000,
      requestedBy: 'admin:falso',
    })
    expect(spoofed.status).toBe(HttpStatus.CREATED)

    const omitted = await postRefund({ paymentId: paymentB.id, amount: 5000 })
    expect(omitted.status).toBe(HttpStatus.CREATED)

    const savedA = await refundRepo.findOneByOrFail({ paymentId: paymentA.id })
    const savedB = await refundRepo.findOneByOrFail({ paymentId: paymentB.id })
    expect(savedA.requestedBy).toBe(USER_A)
    expect(savedB.requestedBy).toBe(USER_A)
  })

  it('persists triggeredBy from the session in subscription_events on cancel and reactivate when body carries admin:falso', async () => {
    // R15 (Mutation): restoring `data.triggeredBy` in the controller writes `admin:falso` into subscription_events.
    const now = new Date()
    const periodEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    const sub = await subRepo.save(
      subRepo.create({
        brandId: BRAND_A,
        userId: USER_A,
        planSlug: 'pro',
        status: SubscriptionStatus.ACTIVE,
        provider: SubscriptionProvider.WALLET,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        nextBillingDate: periodEnd,
        autoRenew: true,
      }),
    )

    const cancelRes = await request(app.getHttpServer())
      .post('/v1/subscription/cancel')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        brandId: BRAND_A,
        reason: 'customer cancellation',
        triggeredBy: 'admin:falso',
      })
    expect(cancelRes.status).toBe(HttpStatus.CREATED)

    const reactivateRes = await request(app.getHttpServer())
      .post('/v1/subscription/reactivate')
      .set('Authorization', `Bearer ${userToken}`)
      .send({
        brandId: BRAND_A,
        triggeredBy: 'admin:falso',
      })
    expect(reactivateRes.status).toBe(HttpStatus.CREATED)

    const events = await subEventRepo.find({
      where: { subscriptionId: sub.id },
      order: { createdAt: 'ASC' },
    })
    expect(events.map((e) => [e.eventType, e.triggeredBy])).toEqual([
      [SubscriptionEventType.CANCELLED, USER_A],
      [SubscriptionEventType.REACTIVATED, USER_A],
    ])
  })

  it('persists verifiedBy from the session in brand_legal_documents on verify and reject when body carries admin:falso', async () => {
    // R15 (Mutation): restoring `data.verifiedBy` in the controller writes `admin:falso` into brand_legal_documents.
    const doc = await docRepo.save(
      docRepo.create({
        brandId: BRAND_A,
        country: 'CO',
        documentType: 'rut',
        documentUrl: 'https://storage.roaxai.dev/docs/rut.pdf',
        status: DocumentStatus.PENDING,
      }),
    )

    const verifyRes = await request(app.getHttpServer())
      .post(`/v1/billing-profile/admin/documents/${doc.id}/verify`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ verifiedBy: 'admin:falso' })
    expect(verifyRes.status).toBe(HttpStatus.CREATED)

    const afterVerify = await docRepo.findOneByOrFail({ id: doc.id })
    expect(afterVerify.status).toBe(DocumentStatus.VERIFIED)
    expect(afterVerify.verifiedBy).toBe(SUPERADMIN_ID)

    const rejectRes = await request(app.getHttpServer())
      .post(`/v1/billing-profile/admin/documents/${doc.id}/reject`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({ verifiedBy: 'admin:falso', reason: 'blurry scan' })
    expect(rejectRes.status).toBe(HttpStatus.CREATED)

    const afterReject = await docRepo.findOneByOrFail({ id: doc.id })
    expect(afterReject.status).toBe(DocumentStatus.REJECTED)
    expect(afterReject.verifiedBy).toBe(SUPERADMIN_ID)
  })

  it('creates and adjusts a wallet when body carries adminUserId and audits session actor', async () => {
    // R15 (Mutation): dropping `adminUserId` from wallet DTOs rejects with 400 and writes nothing.
    const createRes = await request(app.getHttpServer())
      .post('/v1/admin/wallets')
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        brandId: BRAND_A,
        userId: USER_A,
        provider: 'internal',
        currency: 'COP',
        label: 'Wallet principal',
        balance: 0,
        adminUserId: 'system',
      })
    expect(createRes.status).toBe(HttpStatus.CREATED)
    const walletId = createRes.body.data.id

    const adjustRes = await request(app.getHttpServer())
      .post(`/v1/admin/wallets/${walletId}/adjust`)
      .set('Authorization', `Bearer ${superAdminToken}`)
      .send({
        type: 'credit',
        amount: 2500,
        description: 'Initial credit',
        category: 'admin_adjustment',
        adminUserId: 'system',
        idempotencyKey: `loc115-adjust-${walletId}`,
      })
    expect(adjustRes.status).toBe(HttpStatus.CREATED)

    const wallet = await dataSource.getRepository(Wallet).findOneByOrFail({ id: walletId })
    expect(Number(wallet.balance)).toBe(2500)

    const logs = await dataSource
      .getRepository(AuditLog)
      .find({ where: { entityType: 'wallet', entityId: walletId }, order: { createdAt: 'ASC' } })
    expect(logs.map((l) => [l.action, l.userId])).toEqual([
      ['wallet_created', SUPERADMIN_ID],
      ['wallet_credit', SUPERADMIN_ID],
    ])
  })
})
