import { randomUUID } from 'crypto'
import { DataSource } from 'typeorm'

import { Payment, PaymentProvider } from '../../src/payment/entities/payment.entity'
import { ConfioProvider } from '../../src/provider/confio/confio.provider'
import { DropiProvider } from '../../src/provider/dropi/dropi.provider'
import { MercadoPagoProvider } from '../../src/provider/mercadopago/mercadopago.provider'
import { ProviderFactory } from '../../src/provider/provider.factory'
import { StripeProvider } from '../../src/provider/stripe/stripe.provider'
import { SubscriptionEvent } from '../../src/subscription/entities/subscriptionEvent.entity'
import { onlyBrandPayments, seedExternalPurchase } from './external-purchase.fixture'
import { RaceInstance } from './wallet-race.fixture'

export type ApiProvider = 'mercadopago' | 'dropi' | 'confio'

/** What each provider's own API answers for a payment it confirms for `amount`, if told. */
export const CONFIRMED_BODY: Record<ApiProvider, (amount?: number) => unknown> = {
  mercadopago: (amount) => ({ results: [{ status: 'approved', transaction_amount: amount }] }),
  dropi: (amount) => ({ status: 'paid', amount }),
  confio: (amount) => ({
    status: 'FUNDED',
    amountCents: amount === undefined ? undefined : amount * 100,
  }),
}

/** Credentials the real clients need to get past their configuration check; none are real. */
export function configureProviderClients() {
  Object.assign(process.env, {
    MP_ACCESS_TOKEN: 'mp-test-token',
    DROPI_API_URL: 'https://dropi.invalid',
    DROPI_API_KEY: 'dropi-test-key',
    CONFIO_STORE_ID: 'store-test',
    CONFIO_ACCESS_TOKEN: 'confio-test-token',
    CONFIO_API_BASE_URL: 'https://confio.invalid/v1',
  })
}

const NEW_CLIENT: Record<ApiProvider, () => unknown> = {
  mercadopago: () => new MercadoPagoProvider(),
  dropi: () => new DropiProvider(),
  confio: () => new ConfioProvider(),
}

/** Puts the real client of `provider` behind the instance, its API answering `status` and `body`. */
export function realClientAnswering(
  instance: RaceInstance,
  provider: ApiProvider,
  body: unknown,
  status = 200,
) {
  // R17: The provider's API is a third party; the client that reads its answer stays real.
  jest.spyOn(global, 'fetch').mockImplementation(async (url) => {
    const asksElsewhere = provider === 'mercadopago' && !String(url).includes('/v1/payments/search')
    return asksElsewhere
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(body), { status })
  })
  answerAs(instance, NEW_CLIENT[provider]())
}

/** Puts the real Stripe client behind the instance, its SDK call doing what `retrieve` does. */
export function realStripeClient(instance: RaceInstance, retrieve: () => Promise<unknown>) {
  const client = new StripeProvider()
  // R17: Stripe's SDK reaches a third party; the mapping of its session stays real.
  ;(client as any).stripe = { checkout: { sessions: { retrieve } } }
  answerAs(instance, client)
}

export function stripeSession(amount: number, paymentStatus = 'paid') {
  return {
    status: 'complete',
    payment_status: paymentStatus,
    created: 1,
    amount_total: amount * 100,
  }
}

function answerAs(instance: RaceInstance, client: unknown) {
  ;(instance.moduleRef.get(ProviderFactory) as any).getProvider.mockReturnValue(client)
}

/** A provider whose status answer is whatever `getPaymentStatus` does. */
export function providerDoing(instance: RaceInstance, getPaymentStatus: () => Promise<unknown>) {
  // R17: These cases provoke an interleaving at the moment the provider answers.
  answerAs(instance, { getPaymentStatus: jest.fn().mockImplementation(getPaymentStatus) })
}

/** The provider's whole client is gone: there is nothing to ask. */
export function providerGone(instance: RaceInstance) {
  // R17: An unregistered client throws here exactly as ProviderFactory.getProvider does.
  ;(instance.moduleRef.get(ProviderFactory) as any).getProvider.mockImplementation(() => {
    throw new Error('Payment provider not registered')
  })
}

export function externalPayment(
  dataSource: DataSource,
  brandId: string,
  provider: PaymentProvider,
  age: string,
  overrides: Partial<Payment> = {},
) {
  return seedExternalPurchase(dataSource, brandId, 'dropi-roax', {
    age,
    overrides: { provider, providerPaymentId: `provider-${randomUUID()}`, ...overrides },
  })
}

export function sweepBrand(instance: RaceInstance, brandId: string) {
  onlyBrandPayments(instance, brandId)
  return instance.tasks.reconcileExternalPayments()
}

export function expireBrand(instance: RaceInstance, brandId: string) {
  onlyBrandPayments(instance, brandId)
  return instance.tasks.expirePendingCheckouts()
}

export function eventsOf(dataSource: DataSource, paymentId: string) {
  return dataSource.getRepository(SubscriptionEvent).countBy({ paymentId })
}
