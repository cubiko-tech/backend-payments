import { DataSource } from 'typeorm'

import { CheckoutRequest } from '../../src/checkout/checkout.service'
import { Payment } from '../../src/payment/entities/payment.entity'
import { ProviderFactory } from '../../src/provider/provider.factory'
import { Wallet } from '../../src/wallet/entities/wallet.entity'
import { TokenPackage } from '../../src/wallet/entities/token-package.entity'
import { cleanBrand, RaceInstance } from './wallet-race.fixture'

/** Seed of AddTokenPackages that the cases buy: USD 25 for 25 tokens and a bonus of 2. */
export const TESTEO_SEMANAL = {
  slug: 'testeo-semanal',
  priceUsd: 25,
  purchasedTokens: 25,
  bonusTokens: 2,
}

export const packageId = async (dataSource: DataSource, slug = TESTEO_SEMANAL.slug) =>
  (await dataSource.getRepository(TokenPackage).findOneByOrFail({ slug })).id

/** A Dropi checkout: the provider has a cost, so its client answers with a link and no network. */
export function fakeDropi(instance: RaceInstance) {
  const createCheckout = jest.fn(async () => ({
    providerPaymentId: `dropi-${Date.now()}`,
    checkoutUrl: 'https://pay.example/dropi',
  }))
  // R17: the external provider charges money; the cases only need its link and its notice.
  ;(instance.moduleRef.get(ProviderFactory).getProvider as jest.Mock).mockReturnValue({
    createCheckout,
  })
  return createCheckout
}

export const packageCheckout = (
  brandId: string,
  id: string,
  overrides: Partial<CheckoutRequest> = {},
): CheckoutRequest => ({
  brandId,
  userId: 'user-loc136',
  purpose: 'token_package',
  provider: 'dropi',
  packageId: id,
  ...overrides,
})

/** Dropi's notice: confirms the charged amount in major units. */
export const dropiNotice = (amount: number) => ({ amount, source: 'webhook' })

export const tokenWalletOf = (dataSource: DataSource, brandId: string) =>
  dataSource.getRepository(Wallet).findOneBy({ brandId, currency: 'TKN' })

export const paymentsOf = (dataSource: DataSource, brandId: string) =>
  dataSource.getRepository(Payment).findBy({ brandId })

export async function cleanPackageBrand(dataSource: DataSource, brandId: string) {
  await dataSource.query(
    'DELETE FROM invoice_items WHERE "invoiceId" IN (SELECT id FROM invoices WHERE "brandId" = $1)',
    [brandId],
  )
  await dataSource.query('DELETE FROM invoices WHERE "brandId" = $1', [brandId])
  await cleanBrand(dataSource, brandId)
}
