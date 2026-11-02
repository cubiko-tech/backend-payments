import { PaymentProvider, PaymentStatus } from '../src/payment/entities/payment.entity'
import { subscriptionOf } from './support/external-purchase.fixture'
import {
  configureProviderClients,
  CONFIRMED_BODY,
  expireBrand,
  externalPayment,
  providerDoing,
  providerGone,
  realClientAnswering,
  realStripeClient,
  stripeSession,
  sweepBrand,
} from './support/provider-api.fixture'
import {
  cleanBrand,
  PLAN_PRICE,
  RaceInstance,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7890002-2222-4333-8444-555555555555'
const PAST_EXPIRY = '25 hours'

describe('Expiring external checkouts against their provider (PostgreSQL, LOC-89)', () => {
  let a: RaceInstance

  beforeAll(async () => {
    configureProviderClients()
    a = await startInstance()
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND_ID))

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
  })

  const seed = (column: PaymentProvider) =>
    externalPayment(a.dataSource, BRAND_ID, column, PAST_EXPIRY)
  const expectStatus = async (paymentId: string, status: PaymentStatus) =>
    expect(await statusOf(a.dataSource, paymentId)).toBe(status)

  it('E4 keeps what the provider confirmed, and the sweep completes it', async () => {
    // R15: red if the expiry stops asking the provider: a paid payment ends failed.
    const payment = await seed(PaymentProvider.STRIPE)
    realStripeClient(a, async () => stripeSession(PLAN_PRICE))

    await expireBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.PENDING)

    await sweepBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.COMPLETED)
  })

  it('E4 keeps a payment the provider is still processing', async () => {
    // R15: red if the expiry treats a live attempt as not confirmed: it fails while being paid.
    const payment = await seed(PaymentProvider.MERCADOPAGO)
    realClientAnswering(a, 'mercadopago', { results: [{ status: 'in_process' }] })

    await expireBrand(a, BRAND_ID)

    await expectStatus(payment.id, PaymentStatus.PENDING)
  })

  it('E5 expires what the provider did not confirm', async () => {
    // R15: red if the expiry never expires: abandoned checkouts stay pending forever.
    const payment = await seed(PaymentProvider.STRIPE)
    realStripeClient(a, async () => ({ status: 'open' }))

    await expireBrand(a, BRAND_ID)

    await expectStatus(payment.id, PaymentStatus.FAILED)
  })

  it('E6 expires nothing with the whole client gone, and reconciles when it is back', async () => {
    // R15: red if the expiry treats an error as not confirmed: an outage fails paid payments.
    const payment = await seed(PaymentProvider.STRIPE)
    providerGone(a)

    await expireBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.PENDING)
    await sweepBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.PENDING)
    expect(await subscriptionOf(a.dataSource, BRAND_ID)).toBeNull()

    realStripeClient(a, async () => stripeSession(PLAN_PRICE))
    await sweepBrand(a, BRAND_ID)
    await expectStatus(payment.id, PaymentStatus.COMPLETED)
  })

  it('E6 expires nothing while the Mercado Pago network is down', async () => {
    // R15: red if the Mercado Pago client swallows the failure into pending again.
    const payment = await seed(PaymentProvider.MERCADOPAGO)
    realClientAnswering(a, 'mercadopago', CONFIRMED_BODY.mercadopago(PLAN_PRICE))
    // R17: Refusing the connection is how the whole API being down reaches this client.
    jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'))

    await expireBrand(a, BRAND_ID)

    await expectStatus(payment.id, PaymentStatus.PENDING)
  })

  it('E12 does not fail a payment a webhook claimed after the provider answered', async () => {
    // R15: red if the expiry UPDATE loses its status guard: a completed payment becomes failed.
    const payment = await seed(PaymentProvider.STRIPE)
    providerDoing(a, async () => {
      await a.checkout.completeExternalPayment(payment.id, { source: 'webhook' })
      return { status: 'pending' }
    })

    await expireBrand(a, BRAND_ID)

    await expectStatus(payment.id, PaymentStatus.COMPLETED)
  })

  it('E16 expires a Stripe payment its provider says does not exist', async () => {
    // R15: red if a 404 counts as no answer: the row is asked about on every pass, forever.
    const payment = await seed(PaymentProvider.STRIPE)
    realStripeClient(a, async () => {
      throw Object.assign(new Error('No such checkout.session'), { statusCode: 404 })
    })

    await expireBrand(a, BRAND_ID)

    await expectStatus(payment.id, PaymentStatus.FAILED)
  })

  it.each([{ provider: 'confio' as const, column: PaymentProvider.CONFIO }])(
    'E16 expires a $provider payment its provider says does not exist',
    async (row) => {
      // R15: red if the client loses the 404: the row is asked about on every pass, forever.
      const payment = await seed(row.column)
      realClientAnswering(a, row.provider, { message: 'not found' }, 404)

      await expireBrand(a, BRAND_ID)

      await expectStatus(payment.id, PaymentStatus.FAILED)
    },
  )
})
