/**
 * R6: Shares a single Nest HTTP harness and mock repository graph across the
 * 30-route operator table, the 2 credit activation endpoints, and the 5
 * session-audit mutation routes of AdminController and MetricsController;
 * splitting would duplicate the 200-line module bootstrap.
 */
import { INestApplication } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { AuditService } from '../audit/audit.service'
import { ClientRolesService } from '../client/client-roles.service'
import { CreditService } from '../credit/credit.service'
import { MetricsController } from '../metrics/metrics.controller'
import { MetricsService } from '../metrics/metrics.service'
import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { ProviderConfig } from '../provider/entities/providerConfig.entity'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { Subscription, SubscriptionStatus } from '../subscription/entities/subscription.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { AdminController } from './admin.controller'

const mockQueryBuilder = () => ({
  andWhere: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  skip: jest.fn().mockReturnThis(),
  take: jest.fn().mockReturnThis(),
  getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
})

const mockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn(),
  save: jest.fn((d: any) => Promise.resolve(d)),
  create: jest.fn((d: any) => d),
  count: jest.fn().mockResolvedValue(0),
  createQueryBuilder: jest.fn(() => mockQueryBuilder()),
})

/**
 * Extensión manual de una suscripción desde el panel admin.
 *
 * Se cubre acá y no en un e2e porque lo que hay que fijar es la INVARIANTE de
 * `accessEndsAt` (`subscription.entity.ts`): todo escritor que mueve el fin del
 * servicio tiene que mover también la fecha de corte cuando hay una baja pendiente.
 * Sin eso, «extender 30 días» sobre una fila dada de baja movía `currentPeriodEnd`
 * —que ya no gobierna el acceso— y no le daba a la marca ni un día más.
 */
describe('AdminController — extendSubscription', () => {
  let controller: AdminController
  let subscriptionWriteRepo: ReturnType<typeof mockRepo>
  let auditService: { log: jest.Mock }

  beforeEach(() => {
    subscriptionWriteRepo = mockRepo()
    auditService = { log: jest.fn().mockResolvedValue(undefined) }

    controller = new AdminController(
      mockRepo() as any, // subscriptionReadRepo
      subscriptionWriteRepo as any, // subscriptionWriteRepo
      mockRepo() as any, // paymentReadRepo
      mockRepo() as any, // paymentWriteRepo
      mockRepo() as any, // walletReadRepo
      mockRepo() as any, // walletWriteRepo
      mockRepo() as any, // snapshotReadRepo
      mockRepo() as any, // providerReadRepo
      mockRepo() as any, // providerWriteRepo
      mockRepo() as any, // transactionWriteRepo
      auditService as any,
      {} as any, // creditService
    )
  })

  const fila = (over: Record<string, any> = {}): any => ({
    id: 'sub-1',
    brandId: 'brand-1',
    status: SubscriptionStatus.ACTIVE,
    currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
    nextBillingDate: new Date('2026-09-01T00:00:00.000Z'),
    cancelledAt: null,
    accessEndsAt: null,
    retryCount: 0,
    ...over,
  })

  it('sobre una baja PENDIENTE corre también la fecha de fin de acceso', async () => {
    const sub = fila({
      cancelledAt: new Date('2026-08-20T00:00:00.000Z'),
      accessEndsAt: new Date('2026-09-01T00:00:00.000Z'),
      autoRenew: false,
    })
    subscriptionWriteRepo.findOne.mockResolvedValue(sub)

    await controller.extendSubscription('sub-1', { days: 10 })

    expect(sub.currentPeriodEnd.toISOString()).toBe('2026-09-11T00:00:00.000Z')
    // Lo que la marca REALMENTE gana: el acceso corre los mismos 10 días.
    expect(sub.accessEndsAt.toISOString()).toBe('2026-09-11T00:00:00.000Z')
    expect(subscriptionWriteRepo.save).toHaveBeenCalledWith(sub)
  })

  it('sin baja pendiente la columna sigue nula: extender no inventa una fecha de corte', async () => {
    const sub = fila()
    subscriptionWriteRepo.findOne.mockResolvedValue(sub)

    await controller.extendSubscription('sub-1', { days: 10 })

    expect(sub.currentPeriodEnd.toISOString()).toBe('2026-09-11T00:00:00.000Z')
    // Escribirla acá afirmaría una baja que nadie pidió y haría a la fila elegible
    // para el cron de retiro.
    expect(sub.accessEndsAt).toBeNull()
  })
})

describe('AdminController and MetricsController operator authorization (LOC-46)', () => {
  const TEST_UUID = '11111111-1111-4111-8111-111111111111'
  const JWT_SECRET = 'loc46-test-jwt-secret'
  const SERVER_SECRET = 'loc46-test-server-secret'

  let app: INestApplication
  let jwtService: JwtService
  let userToken: string
  let superAdminToken: string
  let prevJwtSecret: string | undefined
  let prevAccessServer: string | undefined

  let subscriptionReadRepo: ReturnType<typeof mockRepo>
  let subscriptionWriteRepo: ReturnType<typeof mockRepo>
  let paymentReadRepo: ReturnType<typeof mockRepo>
  let paymentWriteRepo: ReturnType<typeof mockRepo>
  let walletReadRepo: ReturnType<typeof mockRepo>
  let walletWriteRepo: ReturnType<typeof mockRepo>
  let snapshotReadRepo: ReturnType<typeof mockRepo>
  let providerReadRepo: ReturnType<typeof mockRepo>
  let providerWriteRepo: ReturnType<typeof mockRepo>
  let transactionWriteRepo: ReturnType<typeof mockRepo>
  let auditService: { log: jest.Mock; findPaginated: jest.Mock }
  let creditService: { listActivationRequests: jest.Mock; updateActivationRequest: jest.Mock }
  let metricsService: Record<string, jest.Mock>
  let rolesService: { checkPermission: jest.Mock }

  beforeAll(async () => {
    prevJwtSecret = process.env.JWT_SECRET
    prevAccessServer = process.env.ACCESS_SERVER
    process.env.JWT_SECRET = JWT_SECRET
    process.env.ACCESS_SERVER = SERVER_SECRET

    jwtService = new JwtService({ secret: JWT_SECRET })
    userToken = jwtService.sign({ id: 'user-regular', isSuperAdmin: false, brand: 'brand-1' })
    superAdminToken = jwtService.sign({ id: 'user-superadmin', isSuperAdmin: true, brand: null })

    subscriptionReadRepo = mockRepo()
    subscriptionWriteRepo = mockRepo()
    paymentReadRepo = mockRepo()
    paymentWriteRepo = mockRepo()
    walletReadRepo = mockRepo()
    walletWriteRepo = mockRepo()
    snapshotReadRepo = mockRepo()
    providerReadRepo = mockRepo()
    providerWriteRepo = mockRepo()
    transactionWriteRepo = mockRepo()
    auditService = {
      log: jest.fn().mockResolvedValue(undefined),
      findPaginated: jest.fn().mockResolvedValue({ data: [], count: 0 }),
    }
    creditService = {
      listActivationRequests: jest.fn().mockResolvedValue({ data: [], total: 0 }),
      updateActivationRequest: jest.fn().mockResolvedValue({ id: TEST_UUID, status: 'approved' }),
    }
    metricsService = {
      getMRR: jest.fn().mockResolvedValue({ data: { mrr: 0 } }),
      getRevenue: jest.fn().mockResolvedValue({ data: { total: 0 } }),
      getChurn: jest.fn().mockResolvedValue({ data: [] }),
      getLTV: jest.fn().mockResolvedValue({ data: [] }),
      getARPU: jest.fn().mockResolvedValue({ data: { arpu: 0 } }),
      getConversion: jest.fn().mockResolvedValue({ data: {} }),
      getPaymentMethods: jest.fn().mockResolvedValue({ data: [] }),
      getRetention: jest.fn().mockResolvedValue({ data: [] }),
      getSnapshots: jest.fn().mockResolvedValue({ data: [] }),
    }
    rolesService = {
      checkPermission: jest.fn().mockResolvedValue(false),
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AdminController, MetricsController],
      providers: [
        ApiAuthGuard,
        Reflector,
        { provide: JwtService, useValue: jwtService },
        { provide: ClientRolesService, useValue: rolesService },
        { provide: getRepositoryToken(Subscription, 'DBRead'), useValue: subscriptionReadRepo },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: subscriptionWriteRepo },
        { provide: getRepositoryToken(Payment, 'DBRead'), useValue: paymentReadRepo },
        { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: paymentWriteRepo },
        { provide: getRepositoryToken(Wallet, 'DBRead'), useValue: walletReadRepo },
        { provide: getRepositoryToken(Wallet, 'DBWrite'), useValue: walletWriteRepo },
        {
          provide: getRepositoryToken(WalletBalanceSnapshot, 'DBRead'),
          useValue: snapshotReadRepo,
        },
        { provide: getRepositoryToken(ProviderConfig, 'DBRead'), useValue: providerReadRepo },
        { provide: getRepositoryToken(ProviderConfig, 'DBWrite'), useValue: providerWriteRepo },
        { provide: getRepositoryToken(Transaction, 'DBWrite'), useValue: transactionWriteRepo },
        { provide: AuditService, useValue: auditService },
        { provide: CreditService, useValue: creditService },
        { provide: MetricsService, useValue: metricsService },
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
    rolesService.checkPermission.mockResolvedValue(false)
    subscriptionReadRepo.createQueryBuilder.mockImplementation(() => mockQueryBuilder())
    paymentReadRepo.createQueryBuilder.mockImplementation(() => mockQueryBuilder())
    walletReadRepo.createQueryBuilder.mockImplementation(() => mockQueryBuilder())
    subscriptionWriteRepo.findOne.mockImplementation(async () => ({
      id: TEST_UUID,
      brandId: 'brand-1',
      status: SubscriptionStatus.ACTIVE,
      currentPeriodEnd: new Date('2026-09-01T00:00:00.000Z'),
      nextBillingDate: new Date('2026-09-01T00:00:00.000Z'),
      accessEndsAt: null,
      retryCount: 0,
    }))
    paymentWriteRepo.findOne.mockImplementation(async () => ({
      id: TEST_UUID,
      status: PaymentStatus.FAILED,
    }))
    walletReadRepo.findOne.mockResolvedValue(null)
    walletWriteRepo.findOne.mockImplementation(async () => ({
      id: TEST_UUID,
      brandId: 'brand-1',
      currency: 'COP',
      balance: 1000,
      status: WalletStatus.ACTIVE,
    }))
    walletWriteRepo.save.mockImplementation((d: any) => Promise.resolve({ id: TEST_UUID, ...d }))
    transactionWriteRepo.save.mockImplementation((d: any) => Promise.resolve({ id: 'tx-1', ...d }))
    providerReadRepo.findOne.mockResolvedValue(null)
    providerWriteRepo.findOne.mockImplementation(async () => ({
      id: TEST_UUID,
      country: 'CO',
      provider: 'stripe',
      isActive: true,
      priority: 1,
    }))
  })

  it('rejects POST /admin/wallets/:id/adjust with 403 for non-superadmin before looking up the wallet', async () => {
    const nonExistentId = '99999999-9999-4999-8999-999999999999'

    const emptyBodyRes = await request(app.getHttpServer())
      .post(`/admin/wallets/${nonExistentId}/adjust`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({})

    expect(emptyBodyRes.status).toBe(403)
    expect(walletWriteRepo.findOne).not.toHaveBeenCalled()
    expect(walletWriteRepo.save).not.toHaveBeenCalled()
    expect(transactionWriteRepo.create).not.toHaveBeenCalled()
    expect(transactionWriteRepo.save).not.toHaveBeenCalled()
    expect(auditService.log).not.toHaveBeenCalled()

    const validBodyRes = await request(app.getHttpServer())
      .post(`/admin/wallets/${TEST_UUID}/adjust`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ type: 'credit', amount: 500 })

    expect(validBodyRes.status).toBe(403)
    expect(walletWriteRepo.findOne).not.toHaveBeenCalled()
    expect(walletWriteRepo.save).not.toHaveBeenCalled()
  })

  it.each([
    ['subscriptions', 'get', '/admin/subscriptions', undefined],
    ['subscriptions summary', 'get', '/admin/subscriptions/summary', undefined],
    ['subscriptions expiring', 'get', '/admin/subscriptions/expiring', undefined],
    ['subscriptions past-due', 'get', '/admin/subscriptions/past-due', undefined],
    ['subscriptions extend', 'post', `/admin/subscriptions/${TEST_UUID}/extend`, { days: 5 }],
    ['payments', 'get', '/admin/payments', undefined],
    ['payments pending', 'get', '/admin/payments/pending', undefined],
    ['payments failed', 'get', '/admin/payments/failed', undefined],
    ['payments stats', 'get', '/admin/payments/stats', undefined],
    ['payments retry', 'post', `/admin/payments/${TEST_UUID}/retry`, {}],
    ['dropi batch-status', 'get', '/admin/dropi/batch-status', undefined],
    ['wallets list', 'get', '/admin/wallets', undefined],
    [
      'wallets create',
      'post',
      '/admin/wallets',
      { brandId: 'brand-1', provider: 'internal', currency: 'COP' },
    ],
    ['wallets toggle-freeze', 'post', `/admin/wallets/${TEST_UUID}/toggle-freeze`, {}],
    [
      'wallets adjust',
      'post',
      `/admin/wallets/${TEST_UUID}/adjust`,
      { type: 'credit', amount: 100 },
    ],
    ['wallets summary', 'get', '/admin/wallets/summary', undefined],
    ['wallets inconsistent', 'get', '/admin/wallets/inconsistent', undefined],
    ['audit-log', 'get', '/admin/audit-log', undefined],
    ['providers list', 'get', '/admin/providers', undefined],
    ['providers create', 'post', '/admin/providers', { country: 'CO', provider: 'stripe' }],
    ['providers update', 'patch', `/admin/providers/${TEST_UUID}`, { isActive: false }],
    ['metrics mrr', 'get', '/admin/metrics/mrr', undefined],
    ['metrics revenue', 'get', '/admin/metrics/revenue', undefined],
    ['metrics churn', 'get', '/admin/metrics/churn', undefined],
    ['metrics ltv', 'get', '/admin/metrics/ltv', undefined],
    ['metrics arpu', 'get', '/admin/metrics/arpu', undefined],
    ['metrics conversion', 'get', '/admin/metrics/conversion', undefined],
    ['metrics payment-methods', 'get', '/admin/metrics/payment-methods', undefined],
    ['metrics retention', 'get', '/admin/metrics/retention', undefined],
    ['metrics history', 'get', '/admin/metrics/history', undefined],
  ] as const)(
    'returns 403 for non-superadmin without touching state and 2xx for superadmin and ACCESS_SERVER on %s (%s %s)',
    async (_group, method, path, body) => {
      const forbiddenRes = await (request(app.getHttpServer()) as any)
        [method](path)
        .set('Authorization', `Bearer ${userToken}`)
        .send(body)

      expect(forbiddenRes.status).toBe(403)
      expect(subscriptionWriteRepo.findOne).not.toHaveBeenCalled()
      expect(subscriptionWriteRepo.save).not.toHaveBeenCalled()
      expect(paymentWriteRepo.findOne).not.toHaveBeenCalled()
      expect(paymentWriteRepo.save).not.toHaveBeenCalled()
      expect(walletReadRepo.findOne).not.toHaveBeenCalled()
      expect(walletWriteRepo.findOne).not.toHaveBeenCalled()
      expect(walletWriteRepo.create).not.toHaveBeenCalled()
      expect(walletWriteRepo.save).not.toHaveBeenCalled()
      expect(providerReadRepo.findOne).not.toHaveBeenCalled()
      expect(providerWriteRepo.findOne).not.toHaveBeenCalled()
      expect(providerWriteRepo.create).not.toHaveBeenCalled()
      expect(providerWriteRepo.save).not.toHaveBeenCalled()

      const allowedRes = await (request(app.getHttpServer()) as any)
        [method](path)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(body)

      expect(allowedRes.status).toBeGreaterThanOrEqual(200)
      expect(allowedRes.status).toBeLessThan(300)
      expect(allowedRes.body).not.toHaveProperty('error')

      const serverRes = await (request(app.getHttpServer()) as any)
        [method](path)
        .set('Authorization', `Bearer ${SERVER_SECRET}`)
        .send(body)

      expect(serverRes.status).toBeGreaterThanOrEqual(200)
      expect(serverRes.status).toBeLessThan(300)
      expect(serverRes.body).not.toHaveProperty('error')
    },
  )

  it('allows ACCESS_SERVER token on admin and metrics routes, including POST /admin/wallets (LOC-49)', async () => {
    for (const path of [
      '/admin/subscriptions',
      '/admin/wallets',
      '/admin/audit-log',
      '/admin/providers',
      '/admin/metrics/mrr',
    ]) {
      const res = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${SERVER_SECRET}`)

      expect(res.status).toBe(200)
    }

    const createWalletRes = await request(app.getHttpServer())
      .post('/admin/wallets')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
      .send({
        brandId: 'brand-loc49',
        provider: 'internal',
        currency: 'cop',
        label: 'Brand wallet',
      })

    expect(createWalletRes.status).toBe(201)
    expect(walletWriteRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: 'brand-loc49',
        userId: 'brand-loc49',
        provider: 'internal',
        currency: 'COP',
        label: 'Brand wallet',
        balance: 0,
        status: WalletStatus.ACTIVE,
      }),
    )
    expect(walletWriteRepo.save).toHaveBeenCalledTimes(1)
    expect(createWalletRes.body).toEqual({
      data: expect.objectContaining({
        id: TEST_UUID,
        brandId: 'brand-loc49',
        provider: 'internal',
        currency: 'COP',
        status: WalletStatus.ACTIVE,
      }),
    })
  })

  it('preserves credit:runs permission check and operator access on credit/activation-requests routes', async () => {
    rolesService.checkPermission.mockResolvedValue(false)
    const deniedRes = await request(app.getHttpServer())
      .get('/admin/credit/activation-requests')
      .set('Authorization', `Bearer ${userToken}`)
    expect(deniedRes.status).toBe(403)
    expect(creditService.listActivationRequests).not.toHaveBeenCalled()

    rolesService.checkPermission.mockResolvedValue(true)
    const allowedGetRes = await request(app.getHttpServer())
      .get('/admin/credit/activation-requests')
      .set('Authorization', `Bearer ${userToken}`)
    expect(allowedGetRes.status).toBe(200)
    expect(rolesService.checkPermission).toHaveBeenCalledWith('user-regular', 'credit:runs')
    expect(creditService.listActivationRequests).toHaveBeenCalledTimes(1)

    const allowedPatchRes = await request(app.getHttpServer())
      .patch(`/admin/credit/activation-requests/${TEST_UUID}`)
      .set('Authorization', `Bearer ${userToken}`)
      .send({ notes: 'reviewed' })
    expect(allowedPatchRes.status).toBe(200)
    expect(creditService.updateActivationRequest).toHaveBeenCalledTimes(1)

    rolesService.checkPermission.mockClear()
    rolesService.checkPermission.mockResolvedValue(false)

    const superAdminGetRes = await request(app.getHttpServer())
      .get('/admin/credit/activation-requests')
      .set('Authorization', `Bearer ${superAdminToken}`)
    expect(superAdminGetRes.status).toBe(200)

    const serverGetRes = await request(app.getHttpServer())
      .get('/admin/credit/activation-requests')
      .set('Authorization', `Bearer ${SERVER_SECRET}`)
    expect(serverGetRes.status).toBe(200)
    expect(rolesService.checkPermission).not.toHaveBeenCalled()
  })

  it.each([
    [
      'subscriptions/:id/extend',
      `/admin/subscriptions/${TEST_UUID}/extend`,
      { days: 5, adminUserId: 'otro' },
      'subscription_extended',
      'subscription',
    ],
    [
      'payments/:id/retry',
      `/admin/payments/${TEST_UUID}/retry`,
      { adminUserId: 'otro' },
      'payment_retry',
      'payment',
    ],
    [
      'wallets',
      '/admin/wallets',
      { brandId: 'brand-1', provider: 'internal', currency: 'COP', adminUserId: 'otro' },
      'wallet_created',
      'wallet',
    ],
    [
      'wallets/:id/toggle-freeze',
      `/admin/wallets/${TEST_UUID}/toggle-freeze`,
      { adminUserId: 'otro' },
      'wallet_frozen',
      'wallet',
    ],
    [
      'wallets/:id/adjust',
      `/admin/wallets/${TEST_UUID}/adjust`,
      { type: 'credit', amount: 100, adminUserId: 'otro' },
      'wallet_credit',
      'wallet',
    ],
  ] as const)(
    'records session actor and ignores body.adminUserId on POST %s (LOC-50)',
    async (routeName, path, body, expectedAction, expectedEntityType) => {
      const auditEntries: Array<Record<string, any>> = []
      auditService.log.mockImplementation(
        async (userId, action, entityType, entityId, changes, description) => {
          const entry = { userId, action, entityType, entityId, changes, description }
          auditEntries.unshift(entry)
          return { data: entry }
        },
      )
      auditService.findPaginated.mockImplementation(async () => ({
        data: [...auditEntries],
        count: auditEntries.length,
      }))

      const superAdminRes = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${superAdminToken}`)
        .send(body)

      expect(superAdminRes.status).toBe(201)
      expect(auditService.log).toHaveBeenCalledTimes(1)
      expect(auditService.log).toHaveBeenCalledWith(
        'user-superadmin',
        expectedAction,
        expectedEntityType,
        TEST_UUID,
        expect.any(Object),
        expect.any(String),
      )
      if (routeName === 'wallets/:id/adjust') {
        expect(transactionWriteRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ referenceId: 'user-superadmin' }),
        )
      }

      const superAdminAuditRes = await request(app.getHttpServer())
        .get('/admin/audit-log')
        .set('Authorization', `Bearer ${superAdminToken}`)
      expect(superAdminAuditRes.status).toBe(200)
      expect(superAdminAuditRes.body.data[0]).toEqual(
        expect.objectContaining({
          userId: 'user-superadmin',
          action: expectedAction,
          entityType: expectedEntityType,
          entityId: TEST_UUID,
        }),
      )

      auditService.log.mockClear()
      transactionWriteRepo.create.mockClear()

      const serverRes = await request(app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${SERVER_SECRET}`)
        .send(body)

      expect(serverRes.status).toBe(201)
      expect(auditService.log).toHaveBeenCalledTimes(1)
      expect(auditService.log).toHaveBeenCalledWith(
        'server',
        expectedAction,
        expectedEntityType,
        TEST_UUID,
        expect.any(Object),
        expect.any(String),
      )
      if (routeName === 'wallets/:id/adjust') {
        expect(transactionWriteRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ referenceId: 'server' }),
        )
      }

      const serverAuditRes = await request(app.getHttpServer())
        .get('/admin/audit-log')
        .set('Authorization', `Bearer ${SERVER_SECRET}`)
      expect(serverAuditRes.status).toBe(200)
      expect(serverAuditRes.body.data[0]).toEqual(
        expect.objectContaining({
          userId: 'server',
          action: expectedAction,
          entityType: expectedEntityType,
          entityId: TEST_UUID,
        }),
      )
    },
  )
})
