import { existsSync } from 'fs'
import { join } from 'path'
import { HttpStatus, INestApplication } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { Test, TestingModule } from '@nestjs/testing'
import * as request from 'supertest'

import { CheckoutController } from '../checkout/checkout.controller'
import { CheckoutService } from '../checkout/checkout.service'
import { ClientPlatformService } from '../client/client-platform.service'
import { ClientRolesService } from '../client/client-roles.service'
import { ProviderConfigService } from '../provider/provider-config.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { PaymentController } from './payment.controller'
import { PaymentService } from './payment.service'

const ACCESS_SERVER = 'unit-payment-controller-server-token'
const BRAND_ID = '11111111-2222-4333-8444-555555555555'

describe('PaymentController — POST /payment/checkout removal (LOC-93)', () => {
  let app: INestApplication
  let processCheckoutMock: jest.Mock
  const envSnapshot = {
    ACCESS_SERVER: process.env.ACCESS_SERVER,
    JWT_SECRET: process.env.JWT_SECRET,
  }

  beforeAll(async () => {
    process.env.ACCESS_SERVER = ACCESS_SERVER
    process.env.JWT_SECRET = 'unit-payment-controller-jwt-secret'
    // R17: Service doubles isolate HTTP routing on PaymentController and CheckoutController from DB.
    processCheckoutMock = jest.fn().mockResolvedValue({
      paymentId: 'pay-unit-1',
      status: 'completed',
    })
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController, CheckoutController],
      providers: [
        ApiAuthGuard,
        JwtService,
        {
          provide: PaymentService,
          // R17: In-memory PaymentService stub satisfies controller DI without opening a database.
          useValue: {
            getPaymentById: jest.fn(),
            getPaymentsByBrand: jest.fn(),
            cancelPayment: jest.fn(),
          },
        },
        {
          provide: CheckoutService,
          useValue: {
            processCheckout: processCheckoutMock,
            // R17: Stubbed reconcilePayment satisfies CheckoutController dependency without external I/O.
            reconcilePayment: jest.fn(),
          },
        },
        {
          provide: ProviderConfigService,
          // R17: Stubbed ProviderConfigService satisfies CheckoutController constructor DI.
          useValue: { getAvailableProviders: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: ClientPlatformService,
          // R17: Stubbed ClientPlatformService avoids outbound HTTP calls to backend-platform.
          useValue: { canViewBrandCredit: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: ClientRolesService,
          // R17: Stubbed ClientRolesService satisfies ApiAuthGuard constructor DI without backend-roles HTTP calls.
          useValue: { checkPermission: jest.fn().mockResolvedValue(true) },
        },
      ],
    }).compile()

    app = moduleFixture.createNestApplication()
    await app.init()
  })

  beforeEach(() => {
    processCheckoutMock.mockClear()
  })

  afterAll(async () => {
    try {
      if (app) await app.close()
    } finally {
      process.env.ACCESS_SERVER = envSnapshot.ACCESS_SERVER
      process.env.JWT_SECRET = envSnapshot.JWT_SECRET
    }
  })

  it('responds 404 on POST /payment/checkout and removes its method and DTO', async () => {
    // R15 (Mutation): restoring @Post('checkout') createCheckout on PaymentController returns 201 and turns this red.
    const res = await request(app.getHttpServer())
      .post('/payment/checkout')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
      .send({
        brandId: BRAND_ID,
        userId: 'user-1',
        provider: 'wallet',
        amount: 1,
        currency: 'COP',
        purpose: 'plan_purchase',
        purposeId: 'dropi-roax',
        idempotencyKey: 'spoofed-key',
        metadata: { idempotencyFingerprint: 'spoofed-fingerprint' },
      })

    expect(res.status).toBe(HttpStatus.NOT_FOUND)
    expect(Reflect.get(PaymentController.prototype, 'createCheckout')).toBeUndefined()
    expect(Reflect.get(PaymentService.prototype, 'createCheckout')).toBeUndefined()
    expect(existsSync(join(__dirname, 'dto', 'create-payment-checkout.dto.ts'))).toBe(false)
  })

  it('keeps POST /checkout working without changes', async () => {
    // R15 (Mutation): removing @Post() processCheckout from CheckoutController returns 404 and turns this red.
    const res = await request(app.getHttpServer())
      .post('/checkout')
      .set('Authorization', `Bearer ${ACCESS_SERVER}`)
      .set('Idempotency-Key', 'idem-checkout-ok-1')
      .send({
        brandId: BRAND_ID,
        userId: 'user-1',
        purpose: 'plan_purchase',
        provider: 'wallet',
        walletId: '22222222-3333-4444-8555-666666666666',
        planSlug: 'dropi-roax',
      })

    expect(res.status).toBe(HttpStatus.CREATED)
    expect(res.body).toEqual({
      data: {
        paymentId: 'pay-unit-1',
        status: 'completed',
      },
    })
    expect(processCheckoutMock).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: BRAND_ID,
        userId: 'user-1',
        purpose: 'plan_purchase',
        provider: 'wallet',
        planSlug: 'dropi-roax',
        idempotencyKey: 'idem-checkout-ok-1',
      }),
    )
  })
})
