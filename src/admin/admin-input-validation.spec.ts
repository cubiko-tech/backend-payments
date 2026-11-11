import { ExecutionContext, INestApplication } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken } from '@nestjs/typeorm'
import * as request from 'supertest'
import { EntityManager } from 'typeorm'
import { AuditService } from '../audit/audit.service'
import { ClientPlatformService } from '../client/client-platform.service'
import { BureauService } from '../credit/bureau/bureau.service'
import { CreditRunService } from '../credit/credit-run.service'
import { CreditController } from '../credit/credit.controller'
import { CreditService } from '../credit/credit.service'
import { ScaleConfigService } from '../credit/scale-config.service'
import { Payment } from '../payment/entities/payment.entity'
import { ProviderConfig } from '../provider/entities/providerConfig.entity'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { GlobalValidationPipe } from '../shared/validation/global-validation-pipe'
import { EnterprisePricingService } from '../subscription/enterprise-pricing.service'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionController } from '../subscription/subscription.controller'
import { SubscriptionService } from '../subscription/subscription.service'
import { Transaction, TransactionType } from '../transaction/entities/transaction.entity'
import { MovementAudit } from '../transaction/movement-audit'
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { TokenWalletService } from '../wallet/token-wallet.service'
import { WalletService } from '../wallet/wallet.service'
import { AdminController } from './admin.controller'
import { MAX_MONEY_AMOUNT } from './dto/money-input'

const VALID_UUID = '11111111-1111-4111-8111-111111111111'
const BRAND_UUID = '22222222-2222-4222-8222-222222222222'
const USER_UUID = '33333333-3333-4333-8333-333333333333'

describe('AdminController, SubscriptionController & CreditController input validation (LOC-123)', () => {
  let app: INestApplication

  // R17: Repo and service doubles isolate HTTP pipe validation from DB and external services.
  const walletReadRepo = { findOne: jest.fn() }
  const adjustedWallet = {
    id: VALID_UUID,
    brandId: BRAND_UUID,
    currency: 'COP',
    balance: 100,
    status: WalletStatus.ACTIVE,
  }
  const walletService = {
    credit: jest.fn(async (walletId: string, amount: number, ...rest: unknown[]) => {
      const transaction = { id: VALID_UUID, walletId, type: TransactionType.CREDIT, amount }
      // Runs the audit inside the credit, as WalletService.credit does before it commits.
      const audit = rest[3] as MovementAudit | undefined
      await audit?.({} as EntityManager, transaction as Transaction)
      return { data: { wallet: adjustedWallet, transaction } }
    }),
  }
  const walletWriteRepo = {
    findOne: jest.fn(),
    create: jest.fn((x) => x),
    save: jest.fn(async (w) => {
      if (typeof w.balance !== 'number' || Number.isNaN(w.balance)) {
        throw new Error('invalid input syntax for type numeric')
      }
      return { id: VALID_UUID, ...w }
    }),
  }
  const providerReadRepo = { findOne: jest.fn() }
  const providerWriteRepo = {
    findOne: jest.fn(),
    create: jest.fn((x) => x),
    save: jest.fn(async (p) => ({ id: VALID_UUID, ...p })),
  }
  const transactionWriteRepo = { findOne: jest.fn().mockResolvedValue(null) }
  const auditService = {
    log: jest.fn().mockResolvedValue(undefined),
    record: jest.fn().mockResolvedValue(undefined),
  }
  const subscriptionService = {
    startTrial: jest.fn().mockResolvedValue({ data: { id: VALID_UUID } }),
    cancel: jest.fn().mockResolvedValue({ data: { id: VALID_UUID } }),
    reactivate: jest.fn().mockResolvedValue({ data: { id: VALID_UUID } }),
  }
  const enterprisePricingService = {
    getForBrand: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({ data: { brandId: BRAND_UUID } }),
    remove: jest.fn().mockResolvedValue({ data: { success: true } }),
  }
  const creditService = {
    getPreapproval: jest.fn().mockResolvedValue({ eligible: true }),
    getByBrand: jest.fn().mockResolvedValue([]),
  }
  const creditRunService = { getRun: jest.fn().mockResolvedValue({ id: VALID_UUID }) }
  const bureauService = {
    getProfile: jest.fn().mockResolvedValue(null),
    upsertProfile: jest.fn().mockResolvedValue({ brandId: BRAND_UUID }),
    grantConsent: jest.fn().mockResolvedValue({ brandId: BRAND_UUID }),
    getChecksByBrand: jest.fn().mockResolvedValue([]),
  }
  const platformClient = { canViewBrandCredit: jest.fn().mockResolvedValue(true) }
  const tokenWallets = {
    getOrCreate: jest.fn().mockResolvedValue({ id: VALID_UUID, brandId: BRAND_UUID }),
  }

  beforeAll(async () => {
    // R17: Guard double injects a superAdmin principal to reach controller pipes directly.
    const allowGuard = {
      canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest()
        req.user = { id: USER_UUID, isSuperAdmin: true, brand: BRAND_UUID }
        return true
      },
    }

    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [AdminController, SubscriptionController, CreditController],
      providers: [
        { provide: getRepositoryToken(Subscription, 'DBRead'), useValue: {} },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: {} },
        { provide: getRepositoryToken(Payment, 'DBRead'), useValue: {} },
        { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: {} },
        { provide: getRepositoryToken(Wallet, 'DBRead'), useValue: walletReadRepo },
        { provide: getRepositoryToken(Wallet, 'DBWrite'), useValue: walletWriteRepo },
        { provide: getRepositoryToken(WalletBalanceSnapshot, 'DBRead'), useValue: {} },
        { provide: getRepositoryToken(ProviderConfig, 'DBRead'), useValue: providerReadRepo },
        { provide: getRepositoryToken(ProviderConfig, 'DBWrite'), useValue: providerWriteRepo },
        { provide: getRepositoryToken(Transaction, 'DBWrite'), useValue: transactionWriteRepo },
        { provide: AuditService, useValue: auditService },
        { provide: CreditService, useValue: creditService },
        { provide: ScaleConfigService, useValue: {} },
        { provide: CreditRunService, useValue: creditRunService },
        { provide: BureauService, useValue: bureauService },
        { provide: SubscriptionService, useValue: subscriptionService },
        { provide: EnterprisePricingService, useValue: enterprisePricingService },
        { provide: ClientPlatformService, useValue: platformClient },
        { provide: WalletService, useValue: walletService },
        { provide: TokenWalletService, useValue: tokenWallets },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue(allowGuard)
      .compile()

    app = moduleRef.createNestApplication()
    app.useGlobalPipes(new GlobalValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app.close()
  })

  beforeEach(() => {
    jest.clearAllMocks()
    walletReadRepo.findOne.mockResolvedValue(null)
    walletWriteRepo.findOne.mockResolvedValue(adjustedWallet)
    transactionWriteRepo.findOne.mockResolvedValue(null)
    providerReadRepo.findOne.mockResolvedValue(null)
  })

  it('rejects POST /admin/wallets with invalid brandId or balance shapes with 400 and writes nothing', async () => {
    // R15 (Mutation): Revert createWallet @Body() to inline type -> returns 500 and calls save.
    for (const invalidBody of [
      { brandId: BRAND_UUID, provider: 'dropi', currency: 'COP', balance: 'abc' },
      { brandId: BRAND_UUID, provider: 'dropi', currency: 'COP', balance: 1e-7 },
      { brandId: BRAND_UUID, provider: 'dropi', currency: 'COP', balance: null },
      { brandId: BRAND_UUID, provider: 'dropi', currency: 'COP', balance: MAX_MONEY_AMOUNT + 1 },
      { brandId: 'x', provider: 'dropi', currency: 'COP', balance: 0 },
      { brandId: 1e-7, provider: 'dropi', currency: 'COP', balance: 0 },
      { brandId: null, provider: 'dropi', currency: 'COP', balance: 0 },
      { brandId: 'a'.repeat(120), provider: 'dropi', currency: 'COP', balance: 0 },
    ]) {
      const res = await request(app.getHttpServer()).post('/admin/wallets').send(invalidBody)
      expect(res.status).toBe(400)
      expect(res.body.code).toBe('INVALID_REQUEST')
    }

    expect(tokenWallets.getOrCreate).not.toHaveBeenCalled()
    expect(walletWriteRepo.save).not.toHaveBeenCalled()
    expect(auditService.log).not.toHaveBeenCalled()
  })

  it('accepts POST /admin/wallets/:id/adjust with echoed id in body and rejects invalid amount or type', async () => {
    // R15 (Mutation): Remove AdjustWalletDto or id field -> bad amount passes or admin call fails.
    const badRes = await request(app.getHttpServer())
      .post(`/admin/wallets/${VALID_UUID}/adjust`)
      .send({ id: VALID_UUID, type: 'credit', amount: -50, idempotencyKey: 'k-bad' })

    expect(badRes.status).toBe(400)
    expect(badRes.body.code).toBe('INVALID_REQUEST')
    expect(walletService.credit).not.toHaveBeenCalled()

    const okRes = await request(app.getHttpServer())
      .post(`/admin/wallets/${VALID_UUID}/adjust`)
      .send({
        id: VALID_UUID,
        type: 'credit',
        amount: 50,
        description: 'Manual top-up',
        category: 'admin_adjustment',
        idempotencyKey: 'k-ok',
      })

    expect(okRes.status).toBe(201)
    expect(walletService.credit).toHaveBeenCalledTimes(1)
  })

  it('accepts POST /admin/wallets and /adjust with adminUserId and audits session actor', async () => {
    // R15 (Mutation): Remove adminUserId from wallet DTOs -> returns 400 and skips write.
    const res = await request(app.getHttpServer()).post('/admin/wallets').send({
      brandId: BRAND_UUID,
      userId: USER_UUID,
      provider: 'internal',
      currency: 'COP',
      label: 'Wallet principal',
      balance: 0,
      adminUserId: 'system',
    })

    expect(res.status).toBe(201)
    expect(tokenWallets.getOrCreate).toHaveBeenCalledWith(BRAND_UUID, USER_UUID)
    expect(walletWriteRepo.save).toHaveBeenCalledTimes(1)
    expect(auditService.log).toHaveBeenCalledWith(
      USER_UUID,
      'wallet_created',
      'wallet',
      VALID_UUID,
      expect.any(Object),
      expect.any(String),
    )

    const adjustRes = await request(app.getHttpServer())
      .post(`/admin/wallets/${VALID_UUID}/adjust`)
      .send({
        type: 'credit',
        amount: 50,
        description: 'Manual top-up',
        category: 'admin_adjustment',
        adminUserId: 'system',
        idempotencyKey: 'k-actor',
      })

    expect(adjustRes.status).toBe(201)
    expect(auditService.record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        userId: USER_UUID,
        action: 'wallet_credit',
        entityType: 'wallet',
        entityId: VALID_UUID,
      }),
    )
  })

  it('validates POST /admin/providers and PATCH /admin/providers/:id bodies with 400 on invalid fields', async () => {
    // R15 (Mutation): Revert provider @Body() to inline types -> writes invalid provider config.
    const badCreate = await request(app.getHttpServer())
      .post('/admin/providers')
      .send({ country: 'COLOMBIA', provider: 'stripe', priority: -1 })

    expect(badCreate.status).toBe(400)
    expect(badCreate.body.code).toBe('INVALID_REQUEST')
    expect(providerWriteRepo.save).not.toHaveBeenCalled()

    const badUpdate = await request(app.getHttpServer())
      .patch(`/admin/providers/${VALID_UUID}`)
      .send({ isActive: 'yes' })

    expect(badUpdate.status).toBe(400)
    expect(badUpdate.body.code).toBe('INVALID_REQUEST')
    expect(providerWriteRepo.findOne).not.toHaveBeenCalled()
  })

  it('validates POST /subscription/trial, /cancel, and /reactivate bodies and rejects unknown fields with 400', async () => {
    // R15 (Mutation): Revert subscription @Body() to inline types -> passes invalid or extra fields.
    const badTrial = await request(app.getHttpServer())
      .post('/subscription/trial')
      .send({ brandId: BRAND_UUID, userId: USER_UUID, planSlug: '' })

    expect(badTrial.status).toBe(400)
    expect(badTrial.body.code).toBe('INVALID_REQUEST')
    expect(subscriptionService.startTrial).not.toHaveBeenCalled()

    const badCancel = await request(app.getHttpServer())
      .post('/subscription/cancel')
      .send({ brandId: BRAND_UUID, reason: 12345 })

    expect(badCancel.status).toBe(400)
    expect(subscriptionService.cancel).not.toHaveBeenCalled()

    const badReactivate = await request(app.getHttpServer())
      .post('/subscription/reactivate')
      .send({ brandId: BRAND_UUID, unexpectedField: true })

    expect(badReactivate.status).toBe(400)
    expect(subscriptionService.reactivate).not.toHaveBeenCalled()
  })

  it('validates :brandId UUID and body on /subscription/enterprise-pricing/:brandId routes', async () => {
    // R15 (Mutation): Remove ParseUUIDPipe or UpsertEnterprisePricingDto -> calls service on bad input.
    const badGet = await request(app.getHttpServer()).get(
      '/subscription/enterprise-pricing/not-a-uuid',
    )
    expect(badGet.status).toBe(400)
    expect(enterprisePricingService.getForBrand).not.toHaveBeenCalled()

    const badPostUuid = await request(app.getHttpServer())
      .post('/subscription/enterprise-pricing/not-a-uuid')
      .send({ monthlyPrice: 150 })
    expect(badPostUuid.status).toBe(400)

    const badPostBody = await request(app.getHttpServer())
      .post(`/subscription/enterprise-pricing/${BRAND_UUID}`)
      .send({ monthlyPrice: -10, currency: 'TOOLONG' })
    expect(badPostBody.status).toBe(400)
    expect(badPostBody.body.code).toBe('INVALID_REQUEST')
    expect(enterprisePricingService.upsert).not.toHaveBeenCalled()

    const badDelete = await request(app.getHttpServer()).delete(
      '/subscription/enterprise-pricing/not-a-uuid',
    )
    expect(badDelete.status).toBe(400)
    expect(enterprisePricingService.remove).not.toHaveBeenCalled()
  })

  it('rejects non-UUID :brandId and :id across CreditController routes with 400', async () => {
    // R15 (Mutation): Remove ParseUUIDPipe from CreditController -> calls services with non-UUIDs.
    const getRoutes = [
      '/credit/preapproval/not-a-uuid',
      '/credit/scores/brand/not-a-uuid',
      '/credit/runs/not-a-uuid',
      '/credit/profile/not-a-uuid',
      '/credit/bureau/checks/brand/not-a-uuid',
    ]

    for (const path of getRoutes) {
      const res = await request(app.getHttpServer()).get(path)
      expect(res.status).toBe(400)
    }

    const postProfile = await request(app.getHttpServer())
      .post('/credit/profile/not-a-uuid')
      .send({ documentType: 'NIT', documentNumber: '900123456', country: 'CO' })
    expect(postProfile.status).toBe(400)

    const postConsent = await request(app.getHttpServer())
      .post('/credit/profile/not-a-uuid/consent')
      .send({ consentVersion: 'v1' })
    expect(postConsent.status).toBe(400)

    expect(creditService.getPreapproval).not.toHaveBeenCalled()
    expect(creditService.getByBrand).not.toHaveBeenCalled()
    expect(creditRunService.getRun).not.toHaveBeenCalled()
    expect(bureauService.getProfile).not.toHaveBeenCalled()
    expect(bureauService.upsertProfile).not.toHaveBeenCalled()
    expect(bureauService.grantConsent).not.toHaveBeenCalled()
    expect(bureauService.getChecksByBrand).not.toHaveBeenCalled()
  })
})
