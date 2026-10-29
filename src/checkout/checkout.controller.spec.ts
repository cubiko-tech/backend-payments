// R6: End-to-end controller + CheckoutService integration matrix shares one Nest TestingModule fixture.
import { ExecutionContext, HttpException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'

import { AuditService } from '../audit/audit.service'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import {
  ALLOWED_BRAND_ROLES,
  BRAND_LOOKUP_UNAVAILABLE,
  ClientPlatformService,
} from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { DianService } from '../dian/dian.service'
import { EventBusService } from '../event-bus/event-bus.service'
import { InvoiceService } from '../invoice/invoice.service'
import { Payment } from '../payment/entities/payment.entity'
import { PaymentAttempt } from '../payment/entities/paymentAttempt.entity'
import { ProviderConfigService } from '../provider/provider-config.service'
import { ProviderFactory } from '../provider/provider.factory'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { EnterprisePricingService } from '../subscription/enterprise-pricing.service'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { SubscriptionService } from '../subscription/subscription.service'
import { TaxService } from '../tax/tax.service'
import { WalletStatus } from '../wallet/entities/wallet.entity'
import { WalletService } from '../wallet/wallet.service'
import { WebhookService } from '../webhook/webhook.service'
import { CheckoutController } from './checkout.controller'
import { CheckoutRequest, CheckoutService } from './checkout.service'

describe('CheckoutController', () => {
  let controller: CheckoutController
  let checkoutService: { processCheckout: jest.Mock }

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        {
          provide: CheckoutService,
          useValue: {
            processCheckout: jest.fn().mockResolvedValue({ paymentId: 'p-1', status: 'completed' }),
          },
        },
        { provide: ProviderConfigService, useValue: { getAvailableProviders: jest.fn() } },
        {
          provide: ClientPlatformService,
          useValue: { canViewBrandCredit: jest.fn().mockResolvedValue(true) },
        },
      ],
    })
      // El controller está detrás de `ApiAuthGuard`, que inyecta `JwtService` y
      // `ClientRolesService`. Este spec prueba la LÓGICA del controller, no la
      // autenticación —eso vive en `shared/auth/api-auth.guard.spec.ts`—, así que
      // el guard se reemplaza por uno que deja pasar. Sin esto Nest falla al
      // resolver `JwtService` en el módulo de test, que es el mismo error que
      // aparecería en runtime si un módulo con endpoints autenticados no tuviera
      // `AuthModule` a mano.
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()

    controller = module.get<CheckoutController>(CheckoutController)
    checkoutService = module.get(CheckoutService)
  })

  it('no deja que un llamador HTTP pida el camino de precios de renovación', async () => {
    await controller.processCheckout({
      brandId: '72a8463b-1111-4c2a-9f1a-66a0985a10e6',
      userId: 'u-1',
      purpose: 'plan_purchase',
      provider: 'wallet',
      planSlug: 'dropi-roax',
      renewal: true,
    })

    // `brandId`/`planSlug` van en la aserción a propósito: sin ellos el test también
    // pasaría si el controller descartara el resto del body en vez de sólo `renewal`.
    expect(checkoutService.processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        renewal: undefined,
        brandId: '72a8463b-1111-4c2a-9f1a-66a0985a10e6',
        planSlug: 'dropi-roax',
      }),
    )
  })

  it('forwards the Idempotency-Key HTTP header to CheckoutService.processCheckout', async () => {
    await controller.processCheckout(
      {
        brandId: '72a8463b-1111-4c2a-9f1a-66a0985a10e6',
        userId: 'u-1',
        purpose: 'plan_purchase',
        provider: 'wallet',
        planSlug: 'dropi-roax',
      },
      { headers: { 'Idempotency-Key': 'idem-key-123' } },
    )

    expect(checkoutService.processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'idem-key-123',
        brandId: '72a8463b-1111-4c2a-9f1a-66a0985a10e6',
        planSlug: 'dropi-roax',
      }),
    )
  })
})

describe('POST /checkout brand membership gate', () => {
  const BRAND_B_ID = '72a8463b-1111-4c2a-9f1a-66a0985a10e6'
  const WALLET_B_ID = 'wallet-brand-b'
  const INITIAL_WALLET_BALANCE = 100000
  const PLAN_PRICE_COP = 19900
  const JWT_SECRET = 'test-checkout-jwt-secret'
  const ACCESS_SERVER = 'test-checkout-server-token'
  const COOKIE_SESSION = 'roax_session'

  const originalFetch = global.fetch
  const envSnapshot = {
    JWT_SECRET: process.env.JWT_SECRET,
    ACCESS_SERVER: process.env.ACCESS_SERVER,
    COOKIE_SESSION: process.env.COOKIE_SESSION,
    SERVICE_PLATFORM: process.env.SERVICE_PLATFORM,
  }

  let controller: CheckoutController
  let guard: ApiAuthGuard
  let jwtService: JwtService
  let platformClient: ClientPlatformService
  let fetchMock: jest.Mock
  let brandBWallet: {
    id: string
    brandId: string
    currency: string
    balance: number
    status?: WalletStatus
  }
  let walletService: { debit: jest.Mock; credit: jest.Mock; findById: jest.Mock }
  let paymentRepo: ReturnType<typeof createMockRepo>
  let invoiceService: { create: jest.Mock }

  const createMockRepo = () => ({
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn((data) => ({ id: 'pay-1', ...data })),
    save: jest.fn((data) => Promise.resolve({ id: 'pay-1', ...data })),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  })

  const signUserCookies = (userId: string): Record<string, string> => {
    const token = jwtService.sign({ id: userId }, { secret: JWT_SECRET })
    return { [COOKIE_SESSION]: token }
  }

  const checkoutBody = (userId: string): CheckoutRequest => ({
    brandId: BRAND_B_ID,
    userId,
    purpose: 'plan_purchase',
    provider: 'wallet',
    walletId: WALLET_B_ID,
    planSlug: 'dropi-roax',
  })

  const postCheckout = async (
    requestAuth: { cookies?: Record<string, string>; headers?: Record<string, string> },
    body: CheckoutRequest,
  ): Promise<{ status: number; body: any }> => {
    const req: any = {
      cookies: requestAuth.cookies || {},
      headers: requestAuth.headers || {},
      body,
    }
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => req,
      }),
      getHandler: () => controller.processCheckout,
    } as unknown as ExecutionContext

    try {
      await guard.canActivate(ctx)
      const data = await controller.processCheckout(body, req)
      return { status: 201, body: data }
    } catch (err) {
      if (err instanceof HttpException) {
        return { status: err.getStatus(), body: err.getResponse() }
      }
      throw err
    }
  }

  beforeEach(async () => {
    process.env.JWT_SECRET = JWT_SECRET
    process.env.ACCESS_SERVER = ACCESS_SERVER
    process.env.COOKIE_SESSION = COOKIE_SESSION
    process.env.SERVICE_PLATFORM = 'http://platform.test'

    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    brandBWallet = {
      id: WALLET_B_ID,
      brandId: BRAND_B_ID,
      currency: 'COP',
      balance: INITIAL_WALLET_BALANCE,
    }

    walletService = {
      debit: jest.fn(async (_walletId: string, amount: number) => {
        brandBWallet.balance -= amount
        return { data: brandBWallet }
      }),
      credit: jest.fn().mockResolvedValue(null),
      findById: jest.fn(async () => ({ data: brandBWallet })),
    }

    paymentRepo = createMockRepo()
    invoiceService = {
      create: jest.fn().mockResolvedValue({ data: { id: 'inv-1', invoiceNumber: 'CK-1' } }),
    }

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        ApiAuthGuard,
        JwtService,
        ClientPlatformService,
        CheckoutService,
        { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: paymentRepo },
        { provide: getRepositoryToken(PaymentAttempt, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(BillingProfile, 'DBRead'), useValue: createMockRepo() },
        { provide: getDataSourceToken('DBWrite'), useValue: { createQueryRunner: jest.fn() } },
        { provide: WalletService, useValue: walletService },
        {
          provide: InvoiceService,
          useValue: invoiceService,
        },
        { provide: SubscriptionService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(null) } },
        {
          provide: TaxService,
          useValue: {
            getTaxForCountry: jest
              .fn()
              .mockResolvedValue({ taxName: 'N/A', taxRate: 0, isInclusive: false }),
          },
        },
        {
          provide: DianService,
          useValue: {
            isConfigured: jest.fn().mockReturnValue(false),
            sendInvoice: jest.fn().mockResolvedValue({ success: true }),
          },
        },
        {
          provide: ProviderFactory,
          useValue: { getProvider: jest.fn() },
        },
        {
          provide: EventBusService,
          useValue: {
            publishPaymentCompleted: jest.fn(),
            notifyPaymentSuccess: jest.fn(),
            notifyInvoiceReady: jest.fn(),
          },
        },
        {
          provide: ClientRolesService,
          useValue: {
            getPlanPrice: jest.fn().mockResolvedValue(PLAN_PRICE_COP),
            resolvePriceForCountry: jest.fn().mockResolvedValue({
              ok: true,
              price: {
                id: 'price-co',
                countryCode: 'CO',
                currency: 'COP',
                price: PLAN_PRICE_COP,
                isDefault: true,
              },
            }),
            assignPlanToBrand: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: EnterprisePricingService,
          useValue: { getForBrand: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: ProviderConfigService,
          useValue: {
            isProviderAvailable: jest.fn().mockResolvedValue(true),
            getAvailableProviders: jest.fn().mockResolvedValue([]),
          },
        },
        { provide: WebhookService, useValue: { setCheckoutService: jest.fn() } },
      ],
    }).compile()

    controller = module.get<CheckoutController>(CheckoutController)
    guard = module.get<ApiAuthGuard>(ApiAuthGuard)
    jwtService = module.get<JwtService>(JwtService)
    platformClient = module.get<ClientPlatformService>(ClientPlatformService)
  })

  afterEach(() => {
    global.fetch = originalFetch
    process.env.JWT_SECRET = envSnapshot.JWT_SECRET
    process.env.ACCESS_SERVER = envSnapshot.ACCESS_SERVER
    process.env.COOKIE_SESSION = envSnapshot.COOKIE_SESSION
    process.env.SERVICE_PLATFORM = envSnapshot.SERVICE_PLATFORM
    jest.restoreAllMocks()
  })

  const mockPlatformResponses = (
    members: Array<{ userId: string; roleName: string }>,
    country = 'CO',
  ) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/v1/brand/rol/user')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: members.map((m) => ({
              user: { id: m.userId },
              rol: { name: m.roleName },
            })),
          }),
        }
      }
      if (url.includes(`/v1/brand/${BRAND_B_ID}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { id: BRAND_B_ID, country },
          }),
        }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
  }

  it('responds 403 and keeps Brand B wallet balance intact when the caller session is not a member of Brand B', async () => {
    mockPlatformResponses([{ userId: 'user-owner-b', roleName: 'superuser' }])

    const response = await postCheckout(
      { cookies: signUserCookies('user-outsider-a') },
      checkoutBody('user-outsider-a'),
    )

    expect({
      status: response.status,
      walletBalance: brandBWallet.balance,
    }).toEqual({
      status: 403,
      walletBalance: INITIAL_WALLET_BALANCE,
    })
    expect(response.body).toEqual(
      expect.objectContaining({
        code: 'forbidden',
        error: 'forbidden',
      }),
    )
    expect(walletService.debit).not.toHaveBeenCalled()
  })

  it('responds 403 and keeps Brand B wallet balance intact when the caller is a member without a paying role', async () => {
    mockPlatformResponses([{ userId: 'user-operator-b', roleName: 'operator' }])

    const response = await postCheckout(
      { cookies: signUserCookies('user-operator-b') },
      checkoutBody('user-operator-b'),
    )

    expect(response.status).toBe(403)
    expect(brandBWallet.balance).toBe(INITIAL_WALLET_BALANCE)
    expect(walletService.debit).not.toHaveBeenCalled()
  })

  it.each(ALLOWED_BRAND_ROLES)(
    'charges Brand B wallet as usual when the caller session is a member with role %s',
    async (roleName) => {
      mockPlatformResponses([{ userId: 'user-member-b', roleName }])

      const response = await postCheckout(
        { cookies: signUserCookies('user-member-b') },
        checkoutBody('user-member-b'),
      )

      expect(response.status).toBe(201)
      expect(response.body).toEqual({
        data: expect.objectContaining({
          paymentId: 'pay-1',
          status: 'completed',
        }),
      })
      expect(walletService.debit).toHaveBeenCalledTimes(1)
      expect(brandBWallet.balance).toBe(INITIAL_WALLET_BALANCE - PLAN_PRICE_COP)
    },
  )

  it('charges Brand B wallet as usual when called with the service token (ACCESS_SERVER)', async () => {
    mockPlatformResponses([{ userId: 'user-owner-b', roleName: 'superuser' }])

    const response = await postCheckout(
      { headers: { authorization: `Bearer ${ACCESS_SERVER}` } },
      checkoutBody('system'),
    )

    expect(response.status).toBe(201)
    expect(response.body).toEqual({
      data: expect.objectContaining({
        paymentId: 'pay-1',
        status: 'completed',
      }),
    })
    expect(walletService.debit).toHaveBeenCalledTimes(1)
    expect(brandBWallet.balance).toBe(INITIAL_WALLET_BALANCE - PLAN_PRICE_COP)
  })

  it('responds 503 BRAND_LOOKUP_UNAVAILABLE without moving Brand B wallet balance when backend-platform does not respond', async () => {
    platformClient.invalidateCountryCache()
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3010'))

    const response = await postCheckout(
      { cookies: signUserCookies('user-member-b') },
      checkoutBody('user-member-b'),
    )

    expect(response.status).toBe(503)
    expect(response.body).toEqual(
      expect.objectContaining({
        code: BRAND_LOOKUP_UNAVAILABLE,
        status: 503,
      }),
    )
    expect(brandBWallet.balance).toBe(INITIAL_WALLET_BALANCE)
    expect(walletService.debit).not.toHaveBeenCalled()
  })

  describe('service_payment amount validation', () => {
    let mockQueryRunner: {
      connect: jest.Mock
      startTransaction: jest.Mock
      commitTransaction: jest.Mock
      rollbackTransaction: jest.Mock
      release: jest.Mock
      manager: {
        findOne: jest.Mock
        create: jest.Mock
        save: jest.Mock
      }
    }

    beforeEach(() => {
      mockPlatformResponses([{ userId: 'user-owner-b', roleName: 'superuser' }])

      brandBWallet = {
        id: WALLET_B_ID,
        brandId: BRAND_B_ID,
        currency: 'COP',
        balance: 1000,
        status: WalletStatus.ACTIVE,
      }

      mockQueryRunner = {
        connect: jest.fn(),
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        rollbackTransaction: jest.fn(),
        release: jest.fn(),
        manager: {
          findOne: jest.fn().mockResolvedValue(brandBWallet),
          create: jest.fn((_entity, data) => data),
          save: jest.fn((_entity, data) => Promise.resolve(data)),
        },
      }

      const realWalletService = new WalletService(
        createMockRepo() as any,
        { findOne: jest.fn(() => Promise.resolve(brandBWallet)) } as any,
        createMockRepo() as any,
        createMockRepo() as any,
        { createQueryRunner: jest.fn(() => mockQueryRunner) } as any,
      )

      walletService.findById.mockImplementation((id: string) => realWalletService.findById(id))
      walletService.debit.mockImplementation((...args: Parameters<WalletService['debit']>) =>
        realWalletService.debit(...args),
      )
    })

    it.each([
      ['negative (-50000)', -50000],
      ['zero (0)', 0],
      ['non-numeric ("abc")', 'abc' as unknown as number],
    ])(
      'responds 400 on POST /checkout service_payment with a %s amount without creating payment, transaction, or invoice and keeps wallet balance at 1000',
      async (_label, invalidAmount) => {
        const response = await postCheckout(
          { cookies: signUserCookies('user-owner-b') },
          {
            brandId: BRAND_B_ID,
            userId: 'user-owner-b',
            purpose: 'service_payment',
            provider: 'wallet',
            walletId: WALLET_B_ID,
            amount: invalidAmount,
            currency: 'COP',
          },
        )

        expect(response.status).toBe(400)
        expect(brandBWallet.balance).toBe(1000)
        expect(paymentRepo.create).not.toHaveBeenCalled()
        expect(paymentRepo.save).not.toHaveBeenCalled()
        expect(mockQueryRunner.startTransaction).not.toHaveBeenCalled()
        expect(mockQueryRunner.manager.save).not.toHaveBeenCalled()
        expect(invoiceService.create).not.toHaveBeenCalled()
      },
    )

    it('charges a positive service_payment amount (100) from a 1000 COP wallet as today', async () => {
      const response = await postCheckout(
        { cookies: signUserCookies('user-owner-b') },
        {
          brandId: BRAND_B_ID,
          userId: 'user-owner-b',
          purpose: 'service_payment',
          provider: 'wallet',
          walletId: WALLET_B_ID,
          amount: 100,
          currency: 'COP',
        },
      )

      expect(response.status).toBe(201)
      expect(brandBWallet.balance).toBe(900)
      expect(paymentRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 100, currency: 'COP', purpose: 'service_payment' }),
      )
      expect(paymentRepo.save).toHaveBeenCalled()
      expect(mockQueryRunner.startTransaction).toHaveBeenCalledTimes(1)
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalledTimes(1)
      expect(invoiceService.create).not.toHaveBeenCalled()
    })
  })

  describe('idempotency via Idempotency-Key header', () => {
    let storedPayments: Map<string, any>
    let seqId: number

    beforeEach(() => {
      mockPlatformResponses([{ userId: 'user-owner-b', roleName: 'superuser' }])
      storedPayments = new Map()
      seqId = 0

      paymentRepo.create.mockImplementation((data: any) => ({
        id: `pay-${++seqId}`,
        ...data,
      }))
      paymentRepo.findOne.mockImplementation(async ({ where }: any) => {
        if (where?.brandId && where?.idempotencyKey) {
          for (const p of storedPayments.values()) {
            if (p.brandId === where.brandId && p.idempotencyKey === where.idempotencyKey) {
              return p
            }
          }
          return null
        }
        if (where?.id) {
          return storedPayments.get(where.id) || null
        }
        return null
      })
      paymentRepo.save.mockImplementation(async (payment: any) => {
        if (payment.idempotencyKey) {
          for (const existing of storedPayments.values()) {
            if (
              existing.id !== payment.id &&
              existing.brandId === payment.brandId &&
              existing.idempotencyKey === payment.idempotencyKey
            ) {
              const err: any = new Error('duplicate key value violates unique constraint')
              err.code = '23505'
              throw err
            }
          }
        }
        storedPayments.set(payment.id, { ...payment })
        return payment
      })
    })

    it('returns 201 with the same paymentId and debits the wallet once on duplicate POST /checkout with the same Idempotency-Key and body', async () => {
      const headers = {
        'authorization': `Bearer ${ACCESS_SERVER}`,
        'Idempotency-Key': 'k1',
      }
      const body: CheckoutRequest = {
        brandId: BRAND_B_ID,
        userId: 'user-owner-b',
        purpose: 'service_payment',
        provider: 'wallet',
        walletId: WALLET_B_ID,
        amount: 10000,
        currency: 'COP',
      }

      const first = await postCheckout({ headers }, body)
      const second = await postCheckout({ headers }, body)

      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
      expect(walletService.debit).toHaveBeenCalledTimes(1)
      expect(second.body.data.paymentId).toBe(first.body.data.paymentId)
      expect(brandBWallet.balance).toBe(INITIAL_WALLET_BALANCE - 10000)
      expect(storedPayments.size).toBe(1)
    })

    it('responds 409 IDEMPOTENCY_KEY_CONFLICT without a new debit when the same Idempotency-Key is sent with a different body', async () => {
      const headers = {
        'authorization': `Bearer ${ACCESS_SERVER}`,
        'Idempotency-Key': 'k1',
      }

      const first = await postCheckout(
        { headers },
        {
          brandId: BRAND_B_ID,
          userId: 'user-owner-b',
          purpose: 'service_payment',
          provider: 'wallet',
          walletId: WALLET_B_ID,
          amount: 10000,
          currency: 'COP',
        },
      )

      const conflict = await postCheckout(
        { headers },
        {
          brandId: BRAND_B_ID,
          userId: 'user-owner-b',
          purpose: 'service_payment',
          provider: 'wallet',
          walletId: WALLET_B_ID,
          amount: 25000,
          currency: 'COP',
        },
      )

      expect(first.status).toBe(201)
      expect(conflict.status).toBe(409)
      expect(conflict.body).toEqual(
        expect.objectContaining({
          code: 'IDEMPOTENCY_KEY_CONFLICT',
        }),
      )
      expect(walletService.debit).toHaveBeenCalledTimes(1)
      expect(brandBWallet.balance).toBe(INITIAL_WALLET_BALANCE - 10000)
    })

    it('charges each POST /checkout as today when no Idempotency-Key header is provided', async () => {
      const headers = {
        authorization: `Bearer ${ACCESS_SERVER}`,
      }
      const body: CheckoutRequest = {
        brandId: BRAND_B_ID,
        userId: 'user-owner-b',
        purpose: 'service_payment',
        provider: 'wallet',
        walletId: WALLET_B_ID,
        amount: 10000,
        currency: 'COP',
      }

      const first = await postCheckout({ headers }, body)
      const second = await postCheckout({ headers }, body)

      expect(first.status).toBe(201)
      expect(second.status).toBe(201)
      expect(second.body.data.paymentId).not.toBe(first.body.data.paymentId)
      expect(walletService.debit).toHaveBeenCalledTimes(2)
      expect(brandBWallet.balance).toBe(INITIAL_WALLET_BALANCE - 20000)
    })
  })
})
