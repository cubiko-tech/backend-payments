import { ExecutionContext, HttpException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'

import { AuditService } from '../audit/audit.service'
import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import { ALLOWED_BRAND_ROLES, ClientPlatformService } from '../client/client-platform.service'
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
  let fetchMock: jest.Mock
  let brandBWallet: { id: string; brandId: string; currency: string; balance: number }
  let walletService: { debit: jest.Mock; credit: jest.Mock; findById: jest.Mock }

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

    const module: TestingModule = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        ApiAuthGuard,
        JwtService,
        ClientPlatformService,
        CheckoutService,
        { provide: getRepositoryToken(Payment, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(PaymentAttempt, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(Subscription, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(SubscriptionEvent, 'DBWrite'), useValue: createMockRepo() },
        { provide: getRepositoryToken(BillingProfile, 'DBRead'), useValue: createMockRepo() },
        { provide: getDataSourceToken('DBWrite'), useValue: { createQueryRunner: jest.fn() } },
        { provide: WalletService, useValue: walletService },
        {
          provide: InvoiceService,
          useValue: {
            create: jest.fn().mockResolvedValue({ data: { id: 'inv-1', invoiceNumber: 'CK-1' } }),
          },
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

  it('rejects a member session without moving Brand B wallet balance when backend-platform does not respond', async () => {
    fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3010'))

    const response = await postCheckout(
      { cookies: signUserCookies('user-member-b') },
      checkoutBody('user-member-b'),
    )

    expect(response.status).toBe(403)
    expect(brandBWallet.balance).toBe(INITIAL_WALLET_BALANCE)
    expect(walletService.debit).not.toHaveBeenCalled()
  })
})
