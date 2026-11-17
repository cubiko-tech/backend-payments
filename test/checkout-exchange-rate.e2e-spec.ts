/**
 * The TRM on the payment, through the only price that is charged with it: a token package bought
 * by a Colombian brand. The rate and its date are stored, the source is queried once per hour, a
 * checkout without a package never queries it, and a retry keeps the rate the payment already has.
 * The source is a local HTTP server and the instance runs on real Postgres; the 503 without a rate
 * lives in test/token-package-checkout.e2e-spec.ts.
 */
import { config as dotenvConfig } from 'dotenv'

import { buildIdempotencyFingerprint } from '../src/checkout/checkout-idempotency'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import {
  cleanPackageBrand,
  fakeExternalProvider,
  packageCheckout,
  packageId,
  paymentsOf,
} from './support/token-package.fixture'
import { TRM_DAY, TrmSource, startTrmSource } from './support/trm-source.fixture'
import { RaceInstance, startInstance, stopInstance } from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = '7c1e2d3f-1351-4a35-9c35-135135135135'

describe('Checkout charged with the TRM (PostgreSQL)', () => {
  let source: TrmSource
  let instance: RaceInstance
  let id: string

  const buy = async (overrides = {}) =>
    (await instance.checkout.processCheckout(packageCheckout(BRAND, id, overrides))).paymentId
  const paymentOf = (paymentId: string) =>
    instance.dataSource.getRepository(Payment).findOneByOrFail({ id: paymentId })

  // Each case gets a cold TRM cache: the instance caches the rate for an hour.
  beforeEach(async () => {
    source = await startTrmSource()
    instance = await startInstance({ realBilling: true, trmUrl: source.url })
    id = await packageId(instance.dataSource)
    await cleanPackageBrand(instance.dataSource, BRAND)
    fakeExternalProvider(instance)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await cleanPackageBrand(instance.dataSource, BRAND)
    await stopInstance(instance)
    await source.close()
  })

  it('stores the rate and its date on the package payment that uses it', async () => {
    // Mutation: drop the exchangeRate spread in processCheckout and the row reads null.
    const row = await paymentOf(await buy())
    expect(Number(row.exchangeRate)).toBe(4000)
    expect(row.exchangeRateDate).toBe(TRM_DAY)
  })

  it('reads the stored rate back as a number, not as the text pg returns for a decimal', async () => {
    // Mutation: drop the transformer from Payment.exchangeRate and the row reads '4000.00'.
    const row = await paymentOf(await buy())
    expect(typeof row.exchangeRate).toBe('number')
  })

  it('queries the source once for two package payments in the same hour', async () => {
    // Mutation: skip the fresh-cache check in TrmService.getUsdCopRate and hits becomes 2.
    await buy()
    await buy()
    expect(source.hits).toBe(1)
  })

  it('does not query the source for a checkout without a package', async () => {
    // Mutation: quote the rate on every checkout in processCheckout and hits becomes 1.
    const { paymentId } = await instance.checkout.processCheckout({
      brandId: BRAND,
      userId: 'user-trm',
      purpose: 'service_payment',
      provider: 'dropi',
      amount: 100000,
      currency: 'COP',
    })
    const row = await paymentOf(paymentId)
    expect(source.hits).toBe(0)
    expect(row.exchangeRate).toBeNull()
    expect(row.exchangeRateDate).toBeNull()
  })

  it('keeps the stored rate when a failed package payment is retried with the same key', async () => {
    // Mutation: quote the rate again in retryFailedIdempotentPayment and the row reads 4000.00.
    const req = packageCheckout(BRAND, id, { idempotencyKey: 'trm-retry-1' })
    const payments = instance.dataSource.getRepository(Payment)
    const failed = await payments.save(
      payments.create({
        brandId: BRAND,
        userId: req.userId,
        idempotencyKey: req.idempotencyKey,
        provider: PaymentProvider.CONFIO,
        amount: 99950,
        currency: 'COP',
        exchangeRate: 3999.5,
        exchangeRateDate: '2026-11-05',
        status: PaymentStatus.FAILED,
        purpose: PaymentPurpose.TOKEN_PACKAGE,
        metadata: { country: 'CO', idempotencyFingerprint: buildIdempotencyFingerprint(req) },
      }),
    )

    await instance.checkout.processCheckout(req)

    const [row] = await paymentsOf(instance.dataSource, BRAND)
    expect(row.id).toBe(failed.id)
    expect(row.status).toBe(PaymentStatus.PENDING)
    expect(Number(row.exchangeRate)).toBe(3999.5)
    expect(row.exchangeRateDate).toBe('2026-11-05')
    expect(source.hits).toBe(0)
  })
})
