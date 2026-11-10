import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { seedExternalPurchase, settleBrand } from './support/external-purchase.fixture'
import {
  cleanBrand,
  movements,
  PLAN_PRICE,
  planCheckout,
  RaceInstance,
  seedWallet,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7101004-2222-4333-8444-555555555555'
const OLD_PLAN = 'dropi-roax'
const NEW_PLAN = 'dropi-roax-plus'

describe('Refunding a lost external purchase to a closed wallet (PostgreSQL, LOC-104)', () => {
  let a: RaceInstance
  let b: RaceInstance

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND_ID))

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
    await stopInstance(b)
  })

  const confirm = (id: string, instance = a) =>
    instance.checkout.completeExternalPayment(id, { source: 'webhook' })
  const creditsOf = (id: string) => movements(a.dataSource, id, TransactionType.CREDIT)
  const walletRow = (id: string) => a.dataSource.getRepository(Wallet).findOneByOrFail({ id })
  const reopenAudits = (id: string) =>
    a.dataSource.getRepository(AuditLog).countBy({ entityId: id, action: 'wallet_reopened' })

  /** Empty and closed through the service: a wallet with balance cannot be closed in production. */
  const closedWallet = async () => {
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    await a.wallet.close(wallet.id)
    return wallet
  }

  const pendingOlder = (age = '30 minutes') =>
    seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN, { age })

  const confirmNewer = async () => {
    const newer = await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN, { age: '5 minutes' })
    await confirm(newer.id)
  }

  const lostPurchase = async () => {
    const external = await pendingOlder()
    await confirmNewer()
    return external
  }

  const otherWallets = (count: number) => {
    const repo = a.dataSource.getRepository(Wallet)
    const seeds = Array.from({ length: count }, (_, index) => ({
      brandId: BRAND_ID,
      userId: BRAND_ID,
      provider: `other-${index}`,
      currency: 'COP',
      balance: 0,
    }))
    return repo.save(seeds.map((seed) => repo.create(seed)))
  }

  /** The credit dies after the wallet was changed: only forcing it reaches that point on demand. */
  const crashAfterCredit = async (externalId: string) => {
    // R17: A crash between the credit and the status cannot be provoked on demand.
    jest.spyOn(a.moduleRef.get(AuditService), 'log').mockRejectedValueOnce(new Error('Crash'))
    await expect(confirm(externalId)).rejects.toThrow('Crash')
    expect(await creditsOf(externalId)).toHaveLength(1)
    expect(await statusOf(a.dataSource, externalId)).toBe(PaymentStatus.PROCESSING)
  }

  /** Stuck `processing` after applying its plan; a newer purchase spends the wallet, which closes. */
  const stuckThenLostWithClosedWallet = async () => {
    const external = await pendingOlder()
    const invoices = a.moduleRef.get(InvoiceService) as any
    // R17: A crash between applying the plan and completing cannot be provoked on demand.
    invoices.create.mockRejectedValueOnce(new Error('Invoice crash'))
    await expect(confirm(external.id)).rejects.toThrow('Invoice crash')
    const wallet = await seedWallet(a.dataSource, BRAND_ID, PLAN_PRICE)
    await a.checkout.processCheckout(planCheckout(BRAND_ID, wallet.id, 'spent-all', NEW_PLAN))
    await a.wallet.close(wallet.id)
    return { external, wallet }
  }

  it('E1 reopens a closed wallet to credit the purchase on its confirmation', async () => {
    // R15: red if credit stops reopening: the purchase stays processing without its credit.
    const wallet = await closedWallet()
    const external = await lostPurchase()
    // R17: The warning is the only signal an operator gets that a closed wallet came back.
    const warned = jest.spyOn((a.wallet as any).logger, 'warn')

    await confirm(external.id)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    const row = await walletRow(wallet.id)
    expect(row.status).toBe(WalletStatus.ACTIVE)
    expect(Number(row.balance)).toBe(PLAN_PRICE)
    expect(await reopenAudits(wallet.id)).toBe(1)
    expect(warned).toHaveBeenCalledWith(expect.stringContaining(wallet.id))
  })

  it('E2 reopens it from the sweep for a purchase stuck after applying its plan', async () => {
    // R15: red if the settlement does not ask to reopen: the sweep leaves it processing.
    const { external, wallet } = await stuckThenLostWithClosedWallet()

    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    const row = await walletRow(wallet.id)
    expect(row.status).toBe(WalletStatus.ACTIVE)
    expect(Number(row.balance)).toBe(PLAN_PRICE)
    expect(await reopenAudits(wallet.id)).toBe(1)
  })

  it('E3 does not credit twice when repeated after a crash following the credit', async () => {
    // R15: red if the retry misses the credit already made and has no key: it credits again.
    const wallet = await closedWallet()
    const external = await lostPurchase()
    await crashAfterCredit(external.id)

    await confirm(external.id)
    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect(Number((await walletRow(wallet.id)).balance)).toBe(PLAN_PRICE)
    expect(await reopenAudits(wallet.id)).toBe(1)
  })

  it('E4 credits and reopens once with the sweep of two instances on the same purchase', async () => {
    // R15: red without the per-payment lock, the refund check and the key together: two credits.
    const { external, wallet } = await stuckThenLostWithClosedWallet()

    await Promise.all([settleBrand(a, BRAND_ID), settleBrand(b, BRAND_ID)])

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect(Number((await walletRow(wallet.id)).balance)).toBe(PLAN_PRICE)
    expect(await reopenAudits(wallet.id)).toBe(1)
  })

  it('E5 reopens once for two lost purchases crediting the same wallet at once', async () => {
    // R15: red if the audit row is written whenever the option arrives: two reopenings.
    const wallet = await closedWallet()
    const first = await pendingOlder('30 minutes')
    const second = await pendingOlder('40 minutes')
    await confirmNewer()

    await Promise.all([confirm(first.id, a), confirm(second.id, b)])

    expect(await creditsOf(first.id)).toHaveLength(1)
    expect(await creditsOf(second.id)).toHaveLength(1)
    expect(Number((await walletRow(wallet.id)).balance)).toBe(PLAN_PRICE * 2)
    expect(await reopenAudits(wallet.id)).toBe(1)
  })

  it('E6 leaves the wallet closed when the credit fails, and the sweep finishes it', async () => {
    // R15: red if reopening commits apart from the credit: open with no credit and no way back.
    const wallet = await closedWallet()
    const external = await lostPurchase()
    const createRunner = a.dataSource.createQueryRunner.bind(a.dataSource)
    let failures = 1
    // R17: A failing insert inside the transaction is a database failure with no way to provoke it.
    jest.spyOn(a.dataSource, 'createQueryRunner').mockImplementation((...args) => {
      const runner = createRunner(...args)
      const save = runner.manager.save.bind(runner.manager)
      jest.spyOn(runner.manager, 'save').mockImplementation(async (...saved: any[]) => {
        if (saved[0] === Transaction && failures-- > 0) throw new Error('Insert failed')
        return (save as any)(...saved)
      })
      return runner
    })

    await confirm(external.id)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.PROCESSING)
    expect(await creditsOf(external.id)).toHaveLength(0)
    expect((await walletRow(wallet.id)).status).toBe(WalletStatus.CLOSED)
    expect(await reopenAudits(wallet.id)).toBe(0)

    await settleBrand(a, BRAND_ID)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect((await walletRow(wallet.id)).status).toBe(WalletStatus.ACTIVE)
    expect(await reopenAudits(wallet.id)).toBe(1)
  })

  it('E7 does not reopen again when the credit was made and the wallet closed since', async () => {
    // R15: red if the retry credits again: the wallet is reopened and holds a second credit.
    const wallet = await closedWallet()
    const external = await lostPurchase()
    await crashAfterCredit(external.id)
    const [other] = await otherWallets(1)
    await a.wallet.transfer({
      fromWalletId: wallet.id,
      toWalletId: other.id,
      amount: PLAN_PRICE,
    })
    await a.wallet.close(wallet.id)

    await confirm(external.id)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(await creditsOf(external.id)).toHaveLength(1)
    expect((await walletRow(wallet.id)).status).toBe(WalletStatus.CLOSED)
    expect(await reopenAudits(wallet.id)).toBe(1)
  })

  it('E8 keeps it processing with an error log at the wallet limit, also when repeated', async () => {
    // R15: red if the limit is not logged: nobody learns this purchase needs a person.
    const external = await lostPurchase()
    await otherWallets(10)
    // R17: The error log is what sends a person to resolve this purchase by hand.
    const logged = jest.spyOn((a.checkout as any).log, 'error')

    await confirm(external.id)
    await settleBrand(a, BRAND_ID)

    expect(logged).toHaveBeenCalledTimes(2)
    expect(logged).toHaveBeenCalledWith(expect.stringContaining(external.id))
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('wallet creation failed'))
    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.PROCESSING)
    expect(await creditsOf(external.id)).toHaveLength(0)
  })

  it('E9 credits a frozen wallet and leaves it frozen', async () => {
    // R15: red if the option activates any status: the refund would unfreeze the wallet.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    await a.wallet.freeze(wallet.id)
    const external = await lostPurchase()

    await confirm(external.id)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    const row = await walletRow(wallet.id)
    expect(row.status).toBe(WalletStatus.FROZEN)
    expect(Number(row.balance)).toBe(PLAN_PRICE)
    expect(await reopenAudits(wallet.id)).toBe(0)
  })

  it('E10 reopens at the wallet limit: reopening creates nothing', async () => {
    // R15: red if a closed wallet is skipped: creating one hits the limit and it stays stuck.
    const wallet = await closedWallet()
    await otherWallets(9)
    const external = await lostPurchase()

    await confirm(external.id)

    expect(await statusOf(a.dataSource, external.id)).toBe(PaymentStatus.REFUNDED)
    expect(Number((await walletRow(wallet.id)).balance)).toBe(PLAN_PRICE)
    expect(await a.dataSource.getRepository(Wallet).countBy({ brandId: BRAND_ID })).toBe(10)
  })
})
