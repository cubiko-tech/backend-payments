import { Repository } from 'typeorm'

import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { Subscription } from '../src/subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../src/subscription/entities/subscriptionEvent.entity'
import {
  backdate,
  cleanBrand,
  planCheckout,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7100004-2222-4333-8444-555555555555'
const PLAN = 'dropi-roax'
const DAY_MS = 24 * 60 * 60 * 1000

describe('An external payment that crashes before its subscription event (PostgreSQL, LOC-100)', () => {
  let a: RaceInstance

  beforeAll(async () => {
    a = await startInstance()
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND_ID))

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
  })

  const daysLeft = async () => {
    const sub = await a.dataSource.getRepository(Subscription).findOneBy({ brandId: BRAND_ID })
    return Math.round((new Date(sub!.currentPeriodEnd).getTime() - Date.now()) / DAY_MS)
  }

  /** An external purchase older than the wallet purchase that already names the subscription. */
  const olderExternalPurchase = async () => {
    const repo = a.dataSource.getRepository(Payment)
    const external = await repo.save(
      repo.create({
        brandId: BRAND_ID,
        userId: 'user-loc100',
        provider: PaymentProvider.STRIPE,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: PLAN,
        amount: PLAN_PRICE,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        metadata: { country: 'CO', taxRate: 0.19, taxName: 'IVA' },
      }),
    )
    await backdate(a.dataSource, external.id, '30 minutes')
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 100000)
    await a.checkout.processCheckout(planCheckout(BRAND_ID, wallet.id, 'crash-newer', PLAN))
    return external
  }

  it('adds its days once when the retry comes after the crash', async () => {
    // R15: red without the transaction in finalizeProcessingPayment: 90 days after the retry.
    const external = await olderExternalPurchase()
    expect(await daysLeft()).toBe(30)
    const realSave = Repository.prototype.save
    let crashes = 0
    // R17: On the prototype so it reaches both a manager's repository and the injected one.
    jest.spyOn(Repository.prototype, 'save').mockImplementation(async function (
      this: Repository<any>,
      ...args: any[]
    ) {
      if (crashes === 0 && this.metadata.target === SubscriptionEvent) {
        crashes++
        throw new Error('Crash before the event')
      }
      return (realSave as any).apply(this, args)
    } as any)

    await expect(a.checkout.completeExternalPayment(external.id)).rejects.toThrow(
      'Crash before the event',
    )
    expect(crashes).toBe(1)
    expect(await daysLeft()).toBe(30)

    await a.checkout.completeExternalPayment(external.id)

    expect(await daysLeft()).toBe(60)
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.COMPLETED)
    const events = await a.dataSource
      .getRepository(SubscriptionEvent)
      .countBy({ paymentId: external.id })
    expect(events).toBe(1)
  })
})
