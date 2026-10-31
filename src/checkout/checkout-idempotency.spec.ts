import { HttpStatus } from '@nestjs/common'

import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payment/entities/payment.entity'
import { RequestException } from '../shared/exception/request.exception'
import { buildIdempotencyFingerprint } from './checkout-idempotency'
import { CheckoutRequest, CheckoutService } from './checkout.service'

const BRAND_ID = '72a8463b-1111-4c2a-9f1a-66a0985a10e6'
const WALLET_ID = 'w-idem-1'

// R17: Unit-level repository double isolates CheckoutService idempotency branching; real PostgreSQL persistence and transactions are verified in test/checkout-idempotency.e2e-spec.ts.
const createMockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  create: jest.fn((data) => ({ id: 'pay-idem-1', ...data })),
  save: jest.fn((data) => Promise.resolve({ id: 'pay-idem-1', ...data })),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
})

const buildReq = (overrides: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  brandId: BRAND_ID,
  userId: 'user-1',
  purpose: 'plan_purchase',
  provider: 'wallet',
  walletId: WALLET_ID,
  planSlug: 'dropi-roax',
  ...overrides,
})

describe('CheckoutService idempotency recovery and guards', () => {
  let service: CheckoutService
  let paymentRepo: ReturnType<typeof createMockRepo>
  let subscriptionRepo: ReturnType<typeof createMockRepo>
  let walletService: { debit: jest.Mock; credit: jest.Mock; findById: jest.Mock }
  let clientRoles: {
    getPlanPrice: jest.Mock
    resolvePriceForCountry: jest.Mock
    assignPlanToBrand: jest.Mock
  }
  let clientPlatform: { resolveBrandCountry: jest.Mock; getBrandCountry: jest.Mock }
  let createCheckoutMock: jest.Mock
  let storedPayments: Map<string, any>

  const seedStoredPayment = (id: string, overrides: Record<string, any>) => {
    storedPayments.set(id, {
      id,
      brandId: BRAND_ID,
      userId: 'user-1',
      amount: 19900,
      currency: 'COP',
      ...overrides,
    } as unknown as Payment)
  }

  beforeEach(() => {
    storedPayments = new Map()
    paymentRepo = createMockRepo()
    subscriptionRepo = createMockRepo()

    const clone = (p: any) =>
      p ? { ...p, metadata: p.metadata ? { ...p.metadata } : undefined } : null
    paymentRepo.create.mockImplementation((data: any) => ({
      id: 'pay-idem-1',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ...data,
    }))
    paymentRepo.save.mockImplementation(async (payment: Payment) => {
      const copy = clone(payment)
      storedPayments.set(copy.id, copy)
      return copy
    })
    paymentRepo.findOne.mockImplementation(async ({ where }: any) => {
      if (where?.brandId && where?.idempotencyKey) {
        for (const p of storedPayments.values()) {
          if (p.brandId === where.brandId && p.idempotencyKey === where.idempotencyKey)
            return clone(p)
        }
        return null
      }
      return where?.id ? clone(storedPayments.get(where.id)) : null
    })
    paymentRepo.update.mockImplementation(async (criteria: any, partial: any) => {
      const target = storedPayments.get(criteria.id)
      if (!target || (criteria.status && target.status !== criteria.status)) return { affected: 0 }
      storedPayments.set(target.id, { ...target, ...partial })
      return { affected: 1 }
    })

    subscriptionRepo.create.mockImplementation((data: any) => ({ id: 'sub-idem-1', ...data }))
    subscriptionRepo.save.mockImplementation(async (sub: any) => ({ id: 'sub-idem-1', ...sub }))

    // R17: Collaborator doubles isolate CheckoutService orchestration in unit tests; real WalletService + Postgres transactions run in test/checkout-idempotency.e2e-spec.ts.
    walletService = {
      debit: jest.fn().mockResolvedValue({ data: { id: WALLET_ID } }),
      credit: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue({
        data: { id: WALLET_ID, brandId: BRAND_ID, currency: 'COP' },
      }),
    }
    clientRoles = {
      getPlanPrice: jest.fn().mockResolvedValue(19900),
      resolvePriceForCountry: jest.fn().mockResolvedValue({
        ok: true,
        price: { id: 'p-co', countryCode: 'CO', currency: 'COP', price: 19900, isDefault: true },
      }),
      assignPlanToBrand: jest.fn().mockResolvedValue(true),
    }
    clientPlatform = {
      resolveBrandCountry: jest.fn().mockResolvedValue({ ok: true, country: 'CO' }),
      getBrandCountry: jest.fn().mockResolvedValue('CO'),
    }
    createCheckoutMock = jest.fn().mockResolvedValue({
      providerPaymentId: 'cs_live_123',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_live_123',
    })
    // R17: Stateless collaborator doubles for CheckoutService constructor dependencies not under test.
    service = new CheckoutService(
      paymentRepo as any,
      createMockRepo() as any,
      subscriptionRepo as any,
      createMockRepo() as any,
      createMockRepo() as any,
      { createQueryRunner: jest.fn() } as any,
      walletService as any,
      {
        create: jest.fn().mockResolvedValue({ data: { id: 'inv-1', invoiceNumber: 'CK-1' } }),
      } as any,
      {} as any,
      { log: jest.fn().mockResolvedValue(null) } as any,
      {
        getTaxForCountry: jest
          .fn()
          .mockResolvedValue({ taxName: 'IVA', taxRate: 0.19, isInclusive: true }),
      } as any,
      // R17: Outbound billing/provider/event/config doubles isolate unit tests from external I/O.
      {
        isConfigured: jest.fn().mockReturnValue(false),
        sendInvoice: jest.fn().mockResolvedValue({ success: true }),
      } as any,
      { getProvider: jest.fn(() => ({ createCheckout: createCheckoutMock })) } as any,
      {
        publishPaymentCompleted: jest.fn(),
        notifyPaymentSuccess: jest.fn(),
        notifyInvoiceReady: jest.fn(),
      } as any,
      clientRoles as any,
      clientPlatform as any,
      { getForBrand: jest.fn().mockResolvedValue(null) } as any,
      { isProviderAvailable: jest.fn().mockResolvedValue(true) } as any,
      { setCheckoutService: jest.fn() } as any,
    )
  })

  it('retries a failed wallet checkout with the same Idempotency-Key and payload, reusing the payment row and stored pricing', async () => {
    // R15 (Mutation): returning existing failed status in resolvePaymentStateOutcome instead of invoking retryFailedPayment turns this case red.
    walletService.debit
      .mockRejectedValueOnce(new Error('Deadlock detected'))
      .mockResolvedValueOnce({ data: { id: WALLET_ID } })

    const req = buildReq({ idempotencyKey: 'retry-wallet-key-1' })

    await expect(service.processCheckout(req)).rejects.toMatchObject({
      code: 'WALLET_DEBIT_FAILED',
    })
    expect(storedPayments.get('pay-idem-1')?.status).toBe(PaymentStatus.FAILED)

    clientRoles.resolvePriceForCountry.mockClear()
    clientPlatform.resolveBrandCountry.mockClear()

    const retryResult = await service.processCheckout(req)

    expect(retryResult).toEqual({
      paymentId: 'pay-idem-1',
      status: 'completed',
      subscriptionId: 'sub-idem-1',
    })
    expect(storedPayments.size).toBe(1)
    expect(storedPayments.get('pay-idem-1')?.status).toBe(PaymentStatus.COMPLETED)
    expect(storedPayments.get('pay-idem-1')?.failureReason).toBeNull()
    expect(clientRoles.resolvePriceForCountry).not.toHaveBeenCalled()
    expect(clientPlatform.resolveBrandCountry).not.toHaveBeenCalled()
    expect(walletService.debit).toHaveBeenCalledTimes(2)
    expect(walletService.debit).toHaveBeenNthCalledWith(
      2,
      WALLET_ID,
      19900,
      expect.objectContaining({ idempotencyKey: 'payment:pay-idem-1:debit' }),
      'COP',
    )
  })

  it('retries a failed external checkout when the provider failed before assigning providerPaymentId', async () => {
    // R15 (Mutation): treating every FAILED payment as non-retryable in canRetryFailedIdempotentPayment turns this case red with 409.
    createCheckoutMock.mockRejectedValueOnce(new Error('Stripe timeout')).mockResolvedValueOnce({
      providerPaymentId: 'cs_retry_ok',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_retry_ok',
    })

    const req = buildReq({
      provider: 'stripe',
      walletId: undefined,
      idempotencyKey: 'retry-ext-key-1',
    })

    await expect(service.processCheckout(req)).rejects.toMatchObject({ code: 'PROVIDER_ERROR' })
    expect(storedPayments.get('pay-idem-1')?.status).toBe(PaymentStatus.FAILED)
    expect(storedPayments.get('pay-idem-1')?.providerPaymentId).toBeUndefined()

    const retryResult = await service.processCheckout(req)

    expect(retryResult).toEqual({
      paymentId: 'pay-idem-1',
      status: 'pending',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_retry_ok',
    })
    expect(createCheckoutMock).toHaveBeenCalledTimes(2)
    expect(storedPayments.get('pay-idem-1')?.providerPaymentId).toBe('cs_retry_ok')
  })

  it('rejects with 409 IDEMPOTENT_PAYMENT_FAILED when a failed external checkout already has providerPaymentId and stale metadata.checkoutResult', async () => {
    // R15 (Mutation): checking existing.metadata?.checkoutResult before existing.status === PaymentStatus.FAILED returns the expired pending checkoutResult and turns this case red.
    const req = buildReq({
      provider: 'stripe',
      walletId: undefined,
      idempotencyKey: 'expired-ext-key-1',
    })
    seedStoredPayment('pay-expired-1', {
      idempotencyKey: 'expired-ext-key-1',
      provider: PaymentProvider.STRIPE,
      purpose: PaymentPurpose.PLAN_PURCHASE,
      purposeId: 'dropi-roax',
      status: PaymentStatus.FAILED,
      providerPaymentId: 'cs_expired_1',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_expired_1',
      failureReason: 'Expirado tras 24h sin completarse',
      metadata: {
        idempotencyFingerprint: buildIdempotencyFingerprint(req),
        checkoutResult: {
          paymentId: 'pay-expired-1',
          status: 'pending',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_expired_1',
        },
      },
    })

    await expect(service.processCheckout(req)).rejects.toMatchObject({
      code: 'IDEMPOTENT_PAYMENT_FAILED',
      status: HttpStatus.CONFLICT,
    })
    expect(createCheckoutMock).not.toHaveBeenCalled()
  })

  it('rejects with 409 PROVIDER_AMOUNT_MISMATCH when a failed payment has metadata.amountMismatch', async () => {
    // R15 (Mutation): omitting metadata.amountMismatch in createFailedExternalIdempotentPaymentException returns IDEMPOTENT_PAYMENT_FAILED and turns this case red.
    const req = buildReq({
      provider: 'stripe',
      walletId: undefined,
      idempotencyKey: 'mismatch-ext-key-1',
    })
    seedStoredPayment('pay-mismatch-1', {
      idempotencyKey: 'mismatch-ext-key-1',
      provider: PaymentProvider.STRIPE,
      purpose: PaymentPurpose.PLAN_PURCHASE,
      purposeId: 'dropi-roax',
      status: PaymentStatus.FAILED,
      failureReason: 'Provider amount mismatch',
      metadata: {
        idempotencyFingerprint: buildIdempotencyFingerprint(req),
        amountMismatch: { expected: 19900, received: 1000 },
        checkoutResult: {
          paymentId: 'pay-mismatch-1',
          status: 'pending',
          checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_mismatch_1',
        },
      },
    })

    await expect(service.processCheckout(req)).rejects.toMatchObject({
      code: 'PROVIDER_AMOUNT_MISMATCH',
      status: HttpStatus.CONFLICT,
    })
    expect(createCheckoutMock).not.toHaveBeenCalled()
  })

  it('deduplicates two concurrent retries of the same failed payment so walletService.debit runs only once', async () => {
    // R15 (Mutation): removing inFlightCheckouts registration in retryFailedIdempotentPayment causes concurrent retries to run twice and turns this case red.
    const req = buildReq({
      purpose: 'service_payment',
      planSlug: undefined,
      amount: 10000,
      currency: 'COP',
      idempotencyKey: 'concurrent-retry-key',
    })
    seedStoredPayment('pay-idem-1', {
      idempotencyKey: 'concurrent-retry-key',
      walletId: WALLET_ID,
      provider: PaymentProvider.WALLET,
      purpose: PaymentPurpose.SERVICE_PAYMENT,
      amount: 10000,
      status: PaymentStatus.FAILED,
      failureReason: 'Transient failure',
      metadata: { idempotencyFingerprint: buildIdempotencyFingerprint(req) },
    })

    const [first, second] = await Promise.all([
      service.processCheckout(req),
      service.processCheckout(req),
    ])

    expect(first).toEqual({ paymentId: 'pay-idem-1', status: 'completed' })
    expect(second).toEqual({ paymentId: 'pay-idem-1', status: 'completed' })
    expect(walletService.debit).toHaveBeenCalledTimes(1)
  })

  it('rejects with 409 IDEMPOTENT_CHECKOUT_INCOMPLETE when a payment is completed without metadata.checkoutResult', async () => {
    // R15 (Mutation): falling back to { paymentId, status: existing.status } when existing.status === PaymentStatus.COMPLETED and metadata.checkoutResult is missing turns this case red.
    const req = buildReq({ idempotencyKey: 'incomplete-completed-key' })
    seedStoredPayment('pay-incomplete-1', {
      idempotencyKey: 'incomplete-completed-key',
      walletId: WALLET_ID,
      provider: PaymentProvider.WALLET,
      purpose: PaymentPurpose.PLAN_PURCHASE,
      purposeId: 'dropi-roax',
      status: PaymentStatus.COMPLETED,
      metadata: { idempotencyFingerprint: buildIdempotencyFingerprint(req) },
    })

    let caught: RequestException | undefined
    try {
      await service.processCheckout(req)
    } catch (err) {
      caught = err as RequestException
    }

    expect(caught).toBeInstanceOf(RequestException)
    expect(caught?.getStatus()).toBe(HttpStatus.CONFLICT)
    expect(caught?.getResponse()).toMatchObject({
      code: 'IDEMPOTENT_CHECKOUT_INCOMPLETE',
      paymentId: 'pay-incomplete-1',
    })
    expect(walletService.debit).not.toHaveBeenCalled()
  })

  it('rejects with 400 INVALID_IDEMPOTENCY_KEY when trimmed Idempotency-Key exceeds 255 characters and accepts 255 characters', async () => {
    // R15 (Mutation): removing the MAX_IDEMPOTENCY_KEY_LENGTH check in normalizeIdempotencyKey allows a 256-character key to proceed and turns this case red.
    const baseReq = buildReq({
      purpose: 'service_payment',
      planSlug: undefined,
      amount: 10000,
      currency: 'COP',
    })

    await expect(
      service.processCheckout({ ...baseReq, idempotencyKey: 'x'.repeat(256) }),
    ).rejects.toMatchObject({
      code: 'INVALID_IDEMPOTENCY_KEY',
      status: HttpStatus.BAD_REQUEST,
    })
    expect(paymentRepo.findOne).not.toHaveBeenCalled()
    expect(paymentRepo.save).not.toHaveBeenCalled()

    const result = await service.processCheckout({
      ...baseReq,
      idempotencyKey: `  ${'y'.repeat(255)}  `,
    })
    expect(result.status).toBe('completed')
  })

  it('rejects with 409 IDEMPOTENCY_KEY_CONFLICT when retrying a failed payment with a different payload', async () => {
    // R15 (Mutation): moving assertMatchingIdempotencyPayload after the FAILED branch retries the payment instead of throwing 409 and turns this case red.
    const originalReq = buildReq({
      purpose: 'service_payment',
      planSlug: undefined,
      amount: 10000,
      currency: 'COP',
      idempotencyKey: 'conflict-on-failed-key',
    })
    seedStoredPayment('pay-conflict-1', {
      idempotencyKey: 'conflict-on-failed-key',
      walletId: WALLET_ID,
      provider: PaymentProvider.WALLET,
      purpose: PaymentPurpose.SERVICE_PAYMENT,
      amount: 10000,
      status: PaymentStatus.FAILED,
      metadata: { idempotencyFingerprint: buildIdempotencyFingerprint(originalReq) },
    })

    await expect(service.processCheckout({ ...originalReq, amount: 25000 })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      status: HttpStatus.CONFLICT,
    })
    expect(walletService.debit).not.toHaveBeenCalled()
  })
})
