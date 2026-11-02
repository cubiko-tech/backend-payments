import { HttpStatus } from '@nestjs/common'
import { DataSource } from 'typeorm'

import { buildIdempotencyFingerprint } from '../src/checkout/checkout-idempotency'
import { CheckoutRequest } from '../src/checkout/checkout.service'
import * as paymentEntities from '../src/payment/entities/payment.entity'
import { PaymentAttempt } from '../src/payment/entities/paymentAttempt.entity'
import { ProviderConfigService } from '../src/provider/provider-config.service'
import { ProviderFactory } from '../src/provider/provider.factory'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../src/subscription/entities/subscription.entity'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import { ClientRolesService } from '../src/client/client-roles.service'
import {
  balanceOf,
  cleanBrand,
  findPaymentByKey,
  movements,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const { Payment, PaymentProvider, PaymentPurpose, PaymentStatus } = paymentEntities
type Payment = paymentEntities.Payment

const BRAND_ID = 'c98a1111-2222-4333-8444-555555555598'
const NEW_CATALOG_PRICE = 50000
const HOUR_MS = 60 * 60 * 1000

// Only `Date` is controlled: pg and the Nest module keep their real timers and sockets.
const REAL_TIMERS = [
  'hrtime',
  'nextTick',
  'performance',
  'queueMicrotask',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'cancelIdleCallback',
  'setImmediate',
  'clearImmediate',
  'setInterval',
  'clearInterval',
  'setTimeout',
  'clearTimeout',
] as const

describe('Checkout retry window (PostgreSQL)', () => {
  let instance: RaceInstance
  let dataSource: DataSource
  let createCheckout: jest.Mock
  let isProviderAvailable: jest.Mock
  let walletId: string

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * HOUR_MS)
  const walletReq = (key: string): CheckoutRequest => ({
    brandId: BRAND_ID,
    userId: 'user-loc98',
    purpose: 'plan_purchase',
    provider: 'wallet',
    planSlug: 'dropi-roax',
    walletId,
    idempotencyKey: key,
  })
  const stripeReq = (key: string): CheckoutRequest => ({
    ...walletReq(key),
    provider: 'stripe',
    walletId: undefined,
  })

  const seedFailed = async (
    req: CheckoutRequest,
    ageHours: number,
    overrides: Partial<Payment> = {},
  ) => {
    const repo = dataSource.getRepository(Payment)
    const { metadata, ...rest } = overrides
    const saved = await repo.save(
      repo.create({
        brandId: BRAND_ID,
        userId: req.userId,
        idempotencyKey: req.idempotencyKey,
        walletId: req.walletId ?? null,
        provider: req.provider as paymentEntities.PaymentProvider,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: req.planSlug,
        amount: PLAN_PRICE,
        currency: 'COP',
        status: PaymentStatus.FAILED,
        failureReason: 'previous attempt failed',
        metadata: {
          country: 'CO',
          idempotencyFingerprint: buildIdempotencyFingerprint(req),
          ...metadata,
        },
        ...rest,
      }),
    )
    await repo.update({ id: saved.id }, { createdAt: hoursAgo(ageHours) })
    return repo.findOneByOrFail({ id: saved.id })
  }

  const seedDebit = (payment: Payment) =>
    dataSource.getRepository(Transaction).save(
      dataSource.getRepository(Transaction).create({
        walletId,
        brandId: BRAND_ID,
        type: TransactionType.DEBIT,
        amount: PLAN_PRICE,
        balanceBefore: 100000,
        balanceAfter: 100000 - PLAN_PRICE,
        currency: 'COP',
        category: 'plan_payment',
        referenceType: 'payment',
        referenceId: payment.id,
        idempotencyKey: `payment:${payment.id}:debit`,
      } as Partial<Transaction>),
    )

  const reload = (id: string) => dataSource.getRepository(Payment).findOneByOrFail({ id })
  const debitsOf = async (id: string) =>
    (await movements(dataSource, id, TransactionType.DEBIT)).length

  beforeAll(async () => {
    instance = await startInstance()
    dataSource = instance.dataSource
    createCheckout = jest.fn()
    isProviderAvailable = instance.moduleRef.get(ProviderConfigService)
      .isProviderAvailable as unknown as jest.Mock
    const factory = instance.moduleRef.get(ProviderFactory)
    ;(factory.getProvider as jest.Mock).mockReturnValue({ createCheckout })
    // The catalog moved on: any charge at this price means the retry did not reuse the original.
    const roles = instance.moduleRef.get(ClientRolesService)
    ;(roles.resolvePriceForCountry as jest.Mock).mockResolvedValue({
      ok: true,
      price: { countryCode: 'CO', currency: 'COP', price: NEW_CATALOG_PRICE, isDefault: true },
    })
  })

  beforeEach(async () => {
    await cleanBrand(dataSource, BRAND_ID)
    walletId = (await seedWallet(dataSource, BRAND_ID)).id
    createCheckout.mockReset()
    isProviderAvailable.mockReset().mockResolvedValue(true)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    await cleanBrand(dataSource, BRAND_ID)
    await stopInstance(instance)
  })

  it('charges the stored price within the window although the catalog went up', async () => {
    // R15 (Mutation): making isRetryWindowOpen always false turns this red.
    const req = walletReq('loc98-within')
    const failed = await seedFailed(req, 23)

    const result = await instance.checkout.processCheckout(req)

    expect(result).toMatchObject({ paymentId: failed.id, status: 'completed' })
    expect((await reload(failed.id)).status).toBe(PaymentStatus.COMPLETED)
    expect(await balanceOf(dataSource, walletId)).toBe(100000 - PLAN_PRICE)
  })

  it('rejects past the window without charging or writing on the payment', async () => {
    // R15 (Mutation): making isRetryWindowOpen always true turns this red.
    const req = walletReq('loc98-expired')
    const failed = await seedFailed(req, 25)

    await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'IDEMPOTENT_RETRY_EXPIRED',
      status: HttpStatus.CONFLICT,
    })

    const after = await reload(failed.id)
    expect(after.status).toBe(PaymentStatus.FAILED)
    expect(after.createdAt).toEqual(failed.createdAt)
    expect(after.metadata).toEqual(failed.metadata)
    expect(await debitsOf(failed.id)).toBe(0)
    expect(await balanceOf(dataSource, walletId)).toBe(100000)
    expect(await dataSource.getRepository(PaymentAttempt).countBy({ paymentId: failed.id })).toBe(0)
  })

  it('does not renew the window with retries that keep failing', async () => {
    // R15 (Mutation): writing firstAttemptAt = retryNow on each retry turns this red.
    jest.useFakeTimers({ doNotFake: [...REAL_TIMERS] })
    const start = Date.now()
    const req = stripeReq('loc98-renewal')
    createCheckout.mockRejectedValue(new Error('Stripe timeout'))
    const failed = await seedFailed(req, 0)

    for (const hours of [10, 20]) {
      jest.setSystemTime(start + hours * HOUR_MS)
      await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
        code: 'PROVIDER_ERROR',
      })
    }
    expect(createCheckout).toHaveBeenCalledTimes(2)
    expect(new Date((await reload(failed.id)).createdAt).getTime()).toBe(start + 20 * HOUR_MS)

    jest.setSystemTime(start + 25 * HOUR_MS)
    await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'IDEMPOTENT_RETRY_EXPIRED',
    })
    expect(createCheckout).toHaveBeenCalledTimes(2)
  })

  it('rejects a disabled provider within the window without calling it', async () => {
    // R15 (Mutation): removing the provider gate from assertRetryAllowed turns this red.
    const req = stripeReq('loc98-disabled')
    const failed = await seedFailed(req, 1)
    isProviderAvailable.mockResolvedValue(false)

    await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_AVAILABLE',
      status: HttpStatus.BAD_REQUEST,
    })

    expect(createCheckout).not.toHaveBeenCalled()
    expect((await reload(failed.id)).status).toBe(PaymentStatus.FAILED)
  })

  it('gates the retry against the country that decided the original price', async () => {
    // R15 (Mutation): gating with getBillingCountry instead of metadata.country turns this red.
    const req = stripeReq('loc98-country')
    await seedFailed(req, 1, { metadata: { country: 'MX' } })
    // R17: Answers per country as the real config does, so the country in use decides the outcome.
    isProviderAvailable.mockImplementation(async (country: string) => country === 'CO')

    await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_AVAILABLE',
    })

    expect(isProviderAvailable).toHaveBeenCalledWith('MX', 'stripe')
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it('closes a debited payment past the window without a second debit', async () => {
    // R15 (Mutation): removing the debit exemption from assertRetryAllowed turns this red.
    const req = walletReq('loc98-debited')
    const failed = await seedFailed(req, 25)
    await seedDebit(failed)

    const result = await instance.checkout.processCheckout(req)

    expect(result).toMatchObject({ paymentId: failed.id, status: 'completed' })
    expect(await debitsOf(failed.id)).toBe(1)
  })

  it('closes a debited payment whose plan applied without extending it again', async () => {
    // R15 (Mutation): removing the lastPaymentId check of createOrRenewSubscription turns this red.
    const req = walletReq('loc98-applied')
    const failed = await seedFailed(req, 25)
    await seedDebit(failed)
    const periodEnd = new Date(Date.now() + 30 * 24 * HOUR_MS)
    const subs = dataSource.getRepository(Subscription)
    const sub = await subs.save(
      subs.create({
        brandId: BRAND_ID,
        userId: req.userId,
        planSlug: req.planSlug,
        status: SubscriptionStatus.ACTIVE,
        provider: SubscriptionProvider.WALLET,
        currentPeriodStart: new Date(),
        currentPeriodEnd: periodEnd,
        lastPaymentId: failed.id,
      }),
    )

    const result = await instance.checkout.processCheckout(req)

    expect(result).toMatchObject({ paymentId: failed.id, status: 'completed' })
    expect(await debitsOf(failed.id)).toBe(1)
    const after = await subs.findOneByOrFail({ id: sub.id })
    expect(new Date(after.currentPeriodEnd).getTime()).toBe(periodEnd.getTime())
  })

  it('keeps WALLET_DEBIT_FAILED for a debited payment already credited past the window', async () => {
    // R15 (Mutation): removing the debit exemption turns this into IDEMPOTENT_RETRY_EXPIRED, red.
    const req = walletReq('loc98-credited')
    const failed = await seedFailed(req, 25)
    await seedDebit(failed)
    const txs = dataSource.getRepository(Transaction)
    await txs.save(
      txs.create({
        walletId,
        brandId: BRAND_ID,
        type: TransactionType.CREDIT,
        amount: PLAN_PRICE,
        balanceBefore: 100000 - PLAN_PRICE,
        balanceAfter: 100000,
        currency: 'COP',
        category: 'refund',
        referenceType: 'payment',
        referenceId: failed.id,
        idempotencyKey: `payment:${failed.id}:refund`,
      } as Partial<Transaction>),
    )

    await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'WALLET_DEBIT_FAILED',
    })
    expect((await reload(failed.id)).status).toBe(PaymentStatus.FAILED)
  })

  it('rejects both of two concurrent retries past the window', async () => {
    // R15 (Mutation): checking the window after the claim leaves the payment pending and turns this red.
    const req = walletReq('loc98-concurrent')
    const failed = await seedFailed(req, 25)
    // R17: Empty in-flight map stands for two instances, which do not share that memory.
    jest.spyOn((instance.checkout as any).inFlightCheckouts, 'get').mockReturnValue(undefined)

    const results = await Promise.allSettled([
      instance.checkout.processCheckout(req),
      instance.checkout.processCheckout(req),
    ])

    for (const result of results) {
      expect(result).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'IDEMPOTENT_RETRY_EXPIRED' }),
      })
    }
    expect((await reload(failed.id)).status).toBe(PaymentStatus.FAILED)
    expect(await debitsOf(failed.id)).toBe(0)
  })

  it('measures from the birth a payment the sweep expired after a retry', async () => {
    // R15 (Mutation): making isRetryWindowOpen always true sends this retry to the provider, red.
    const req = stripeReq('loc98-swept')
    const pending = await seedFailed(req, 25, {
      status: PaymentStatus.PENDING,
      failureReason: null,
      metadata: { firstAttemptAt: hoursAgo(49).toISOString() },
    })

    await instance.tasks.expirePendingCheckouts()
    expect((await reload(pending.id)).status).toBe(PaymentStatus.FAILED)

    await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'IDEMPOTENT_RETRY_EXPIRED',
    })
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it('tells an abandoned external session past the window to place a new order', async () => {
    // R15 (Mutation): removing the expired branch of the non-retryable payment turns this red.
    const req = stripeReq('loc98-abandoned')
    await seedFailed(req, 25, {
      providerPaymentId: 'cs_abandoned',
      provider: PaymentProvider.STRIPE,
    })

    await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'IDEMPOTENT_RETRY_EXPIRED',
    })
    expect(createCheckout).not.toHaveBeenCalled()
  })

  it('keeps PROVIDER_AMOUNT_MISMATCH past the window', async () => {
    // R15 (Mutation): dropping the amountMismatch condition of the expired branch turns this red.
    const req = stripeReq('loc98-mismatch')
    await seedFailed(req, 25, { metadata: { amountMismatch: { expected: 1, received: 2 } } })

    await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'PROVIDER_AMOUNT_MISMATCH',
    })
  })

  it('lets a real first attempt that fails be retried and keeps its birth', async () => {
    // R15 (Mutation): dropping firstAttemptAt from the retry metadata turns this red.
    const req = stripeReq('loc98-first')
    createCheckout.mockRejectedValueOnce(new Error('Stripe timeout')).mockResolvedValueOnce({
      providerPaymentId: 'cs_ok',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_ok',
    })

    await expect(instance.checkout.processCheckout(req)).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    })
    const first = await findPaymentByKey(dataSource, 'loc98-first')

    await expect(instance.checkout.processCheckout(req)).resolves.toMatchObject({
      status: 'pending',
    })

    const after = await reload(first.id)
    expect(after.metadata.firstAttemptAt).toBe(new Date(first.createdAt).toISOString())
  })
})
