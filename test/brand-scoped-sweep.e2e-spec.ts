import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { scopeSweepsToBrand } from './support/brand-scoped-sweep'
import {
  backdate,
  cleanBrand,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const OWN_BRAND = 'a7130001-2222-4333-8444-555555555555'
const OTHER_BRAND = 'a7130002-2222-4333-8444-555555555555'

describe('Sweeps scoped to the brand of the spec (PostgreSQL, LOC-130)', () => {
  let a: RaceInstance

  const cleanBoth = async () => {
    await cleanBrand(a.dataSource, OWN_BRAND)
    await cleanBrand(a.dataSource, OTHER_BRAND)
  }

  /** A wallet checkout left `pending` with no debit, old enough for every sweep. */
  const seedStalePending = async (brandId: string) => {
    const wallet = await seedWallet(a.dataSource, brandId)
    const repo = a.dataSource.getRepository(Payment)
    const payment = await repo.save(
      repo.create({
        brandId,
        userId: brandId,
        walletId: wallet.id,
        provider: PaymentProvider.WALLET,
        amount: PLAN_PRICE,
        currency: 'COP',
        status: PaymentStatus.PENDING,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: 'dropi-roax',
      }),
    )
    await backdate(a.dataSource, payment.id, '25 hours')
    return payment
  }

  beforeAll(async () => {
    a = await startInstance()
    scopeSweepsToBrand(a.tasks, OWN_BRAND)
  })

  beforeEach(() => cleanBoth())

  afterAll(async () => {
    await cleanBoth()
    await stopInstance(a)
  })

  it('reconcileWalletPayments closes its own brand payment and leaves the other brand one', async () => {
    // R15: red if scopeSweepsToBrand stops adding brandId: the other brand payment ends failed.
    const own = await seedStalePending(OWN_BRAND)
    const other = await seedStalePending(OTHER_BRAND)

    await a.tasks.reconcileWalletPayments()

    expect(await statusOf(a.dataSource, own.id)).toBe(PaymentStatus.FAILED)
    expect(await statusOf(a.dataSource, other.id)).toBe(PaymentStatus.PENDING)
  })

  it('expirePendingCheckouts expires its own brand payment and leaves the other brand one', async () => {
    // R15: red if scopeSweepsToBrand stops adding brandId: the other brand payment ends failed.
    const own = await seedStalePending(OWN_BRAND)
    const other = await seedStalePending(OTHER_BRAND)

    await a.tasks.expirePendingCheckouts()

    expect(await statusOf(a.dataSource, own.id)).toBe(PaymentStatus.FAILED)
    expect(await statusOf(a.dataSource, other.id)).toBe(PaymentStatus.PENDING)
  })
})
