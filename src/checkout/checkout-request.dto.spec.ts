/**
 * `POST /checkout` through the production global pipe: what the DTO rejects never reaches
 * `CheckoutService.processCheckout`, and what the service owns (its domain codes) still reaches it.
 */
import { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import * as request from 'supertest'

import { ClientPlatformService } from '../client/client-platform.service'
import { ProviderConfigService } from '../provider/provider-config.service'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import { createGlobalValidationPipe } from '../shared/validation/global-validation-pipe'
import { CheckoutController } from './checkout.controller'
import { CheckoutService } from './checkout.service'

const BRAND_ID = '72a8463b-1111-4c2a-9f1a-66a0985a10e6'
const WALLET_ID = '0b6f2c4e-2222-4c2a-9f1a-66a0985a10e6'

const serviceBody = (over: Record<string, unknown> = {}) => ({
  brandId: BRAND_ID,
  userId: 'user-1',
  purpose: 'service_payment',
  provider: 'wallet',
  walletId: WALLET_ID,
  amount: 10000,
  currency: 'COP',
  ...over,
})

describe('POST /checkout body validation', () => {
  let app: INestApplication
  let processCheckout: jest.Mock

  beforeAll(async () => {
    // R17: records whether the body reached the service; the real checkout needs a database.
    processCheckout = jest.fn().mockResolvedValue({ paymentId: 'p-1', status: 'pending' })
    const moduleRef = await Test.createTestingModule({
      controllers: [CheckoutController],
      providers: [
        // R17: only the pipe is under test; the service's own guards have their own specs.
        { provide: CheckoutService, useValue: { processCheckout } },
        { provide: ProviderConfigService, useValue: { getAvailableProviders: jest.fn() } },
        // R17: brand membership is out of scope here; checkout.controller.spec covers the gate.
        {
          provide: ClientPlatformService,
          useValue: { canViewBrandCredit: jest.fn().mockResolvedValue(true) },
        },
      ],
    })
      .overrideGuard(ApiAuthGuard)
      .useValue({ canActivate: () => true })
      .compile()
    app = moduleRef.createNestApplication()
    app.useGlobalPipes(createGlobalValidationPipe())
    await app.init()
  })

  afterAll(async () => {
    await app?.close()
  })

  beforeEach(() => processCheckout.mockClear())

  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    request(app.getHttpServer()).post('/checkout').set(headers).send(body)

  it('rejects amount 1e308 with 400 INVALID_REQUEST without calling the service', async () => {
    // R15 (Mutation): the controller receiving the CheckoutRequest interface again lets it through.
    const res = await post(serviceBody({ amount: 1e308 }))

    expect(res.status).toBe(400)
    expect(res.body).toMatchObject({ statusCode: 400, code: 'INVALID_REQUEST' })
    expect(res.body.message).toEqual(expect.arrayContaining([expect.stringContaining('amount')]))
    expect(processCheckout).not.toHaveBeenCalled()
  })

  it('rejects a currency sent as a list', async () => {
    // R15 (Mutation): dropping @Matches on currency lets ['COP'] reach the service.
    const res = await post(serviceBody({ currency: ['COP'] }))

    expect(res.status).toBe(400)
    expect(processCheckout).not.toHaveBeenCalled()
  })

  it('rejects an invented purpose', async () => {
    // R15 (Mutation): dropping @IsIn on purpose lets 'free_money' reach the service.
    const res = await post(serviceBody({ purpose: 'free_money' }))

    expect(res.status).toBe(400)
    expect(processCheckout).not.toHaveBeenCalled()
  })

  it.each([
    ['not a UUID', 'not-a-uuid'],
    ['a number', 123],
  ])('rejects a walletId that is %s', async (_label, walletId) => {
    // R15 (Mutation): dropping @IsUUID on walletId lets it reach the service.
    const res = await post(serviceBody({ walletId }))

    expect(res.status).toBe(400)
    expect(res.body.code).toBe('INVALID_REQUEST')
    expect(processCheckout).not.toHaveBeenCalled()
  })

  it.each([
    ['walletId omitted', { walletId: undefined }],
    ['walletId empty', { walletId: '' }],
    ['walletId blank', { walletId: '   ' }],
    ['amount zero', { amount: 0 }],
    ['amount negative', { amount: -5 }],
    ['amount as a string', { amount: '100' }],
  ])('lets %s reach the service, which owns its domain code', async (_label, over) => {
    // R15 (Mutation): removing the ValidateIf on walletId (blank) or amount (string) answers 400 here.
    const res = await post(serviceBody(over))

    expect(res.status).toBe(201)
    expect(processCheckout).toHaveBeenCalledTimes(1)
  })

  it('accepts the exact body the frontend-platform BFF sends and forwards it whole', async () => {
    // R15 (Mutation): dropping @IsOptional on buyer.email rejects the null the purchase screen sends.
    const res = await post({
      brandId: BRAND_ID,
      userId: 'user-1',
      purpose: 'plan_purchase',
      provider: 'confio',
      planSlug: 'dropi-roax',
      currency: 'COP',
      buyer: { email: null, firstName: null },
    })

    expect(res.status).toBe(201)
    expect(processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: BRAND_ID,
        purpose: 'plan_purchase',
        provider: 'confio',
        planSlug: 'dropi-roax',
        currency: 'COP',
        buyer: { email: null, firstName: null },
      }),
    )
  })

  it('accepts renewal and idempotencyKey in the body and discards both', async () => {
    // R15 (Mutation): dropping @Allow on idempotencyKey answers 400 to a body that carries one.
    const res = await post(serviceBody({ renewal: true, idempotencyKey: 'from-body' }), {
      'Idempotency-Key': 'from-header',
    })

    expect(res.status).toBe(201)
    expect(processCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ renewal: undefined, idempotencyKey: 'from-header' }),
    )
  })
})
