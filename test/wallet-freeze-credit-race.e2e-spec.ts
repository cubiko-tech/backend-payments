import { DataSource, Repository } from 'typeorm'

import { AdminController } from '../src/admin/admin.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import {
  balanceOf,
  cleanBrand,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7101007-2222-4333-8444-555555555555'
const DEBIT = 5000

/** Runs `action` right after the next read of the wallet row, before its reader writes. */
function landAfterNextRead(repo: Repository<Wallet>, action: () => Promise<unknown>) {
  const read = repo.findOne.bind(repo)
  // R17: Only a forced pause lands a movement between the read and the write, whatever the write.
  jest.spyOn(repo, 'findOne').mockImplementationOnce(async (options) => {
    const row = await read(options)
    await action()
    return row
  })
}

async function someoneWaitsOnRowLock(dataSource: DataSource, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const rows = await dataSource.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database()`,
    )
    if (rows.length > 0) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

describe('Freezing a wallet while its balance moves (PostgreSQL, LOC-107)', () => {
  let a: RaceInstance
  let b: RaceInstance
  let repo: Repository<Wallet>
  let admin: AdminController

  const statusOf = async (walletId: string) => (await repo.findOneByOrFail({ id: walletId })).status
  const credit = (walletId: string) =>
    a.wallet.credit(walletId, PLAN_PRICE, { brandId: BRAND_ID, category: 'refund' })
  const seedFrozen = async (balance: number) => {
    const wallet = await seedWallet(a.dataSource, BRAND_ID, balance)
    await repo.update({ id: wallet.id }, { status: WalletStatus.FROZEN })
    return wallet
  }
  const auditActions = async (walletId: string) => {
    const rows = await a.dataSource
      .getRepository(AuditLog)
      .findBy({ entityType: 'wallet', entityId: walletId })
    return rows.map((row) => row.action)
  }

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
    repo = a.dataSource.getRepository(Wallet)
    const unused = null as any
    admin = new AdminController(
      unused,
      unused,
      unused,
      unused,
      unused,
      repo,
      unused,
      unused,
      unused,
      unused,
      a.moduleRef.get(AuditService),
      unused,
    )
  })

  beforeEach(() => cleanBrand(a.dataSource, BRAND_ID))

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
    await stopInstance(b)
  })

  it('E1 freeze keeps a credit that landed after its read', async () => {
    // R15: red when freeze saves the row it read: the balance goes back to 0.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    landAfterNextRead(repo, () => credit(wallet.id))

    const result = await a.wallet.freeze(wallet.id)

    expect(await statusOf(wallet.id)).toBe(WalletStatus.FROZEN)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(PLAN_PRICE)
    expect(Number(result.data!.balance)).toBe(PLAN_PRICE)
  })

  it('E2 freeze keeps a debit that landed after its read', async () => {
    // R15: red when freeze saves the row it read: the debited money comes back.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, PLAN_PRICE)
    landAfterNextRead(repo, () =>
      a.wallet.debit(wallet.id, DEBIT, { brandId: BRAND_ID, category: 'subscription' }),
    )

    await a.wallet.freeze(wallet.id)

    expect(await statusOf(wallet.id)).toBe(WalletStatus.FROZEN)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(PLAN_PRICE - DEBIT)
  })

  it('E3 unfreeze keeps a credit that landed after its read', async () => {
    // R15: red when unfreeze saves the row it read: the balance goes back to 0.
    const wallet = await seedFrozen(0)
    landAfterNextRead(repo, () => credit(wallet.id))

    const result = await a.wallet.unfreeze(wallet.id)

    expect(await statusOf(wallet.id)).toBe(WalletStatus.ACTIVE)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(PLAN_PRICE)
    expect(Number(result.data!.balance)).toBe(PLAN_PRICE)
  })

  it('E4 freeze waits for a credit another instance holds the row lock for', async () => {
    // R15: red when freeze also writes the balance it read: applied after the commit, back to 0.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    const other = b.dataSource.createQueryRunner()
    await other.connect()
    await other.startTransaction()
    try {
      await other.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [wallet.id])
      await other.query('UPDATE wallets SET balance = balance + $2 WHERE id = $1', [
        wallet.id,
        PLAN_PRICE,
      ])

      const freezing = a.wallet.freeze(wallet.id)
      expect(await someoneWaitsOnRowLock(b.dataSource)).toBe(true)
      await other.commitTransaction()
      await freezing
    } finally {
      if (other.isTransactionActive) await other.rollbackTransaction()
      await other.release()
    }

    expect(await statusOf(wallet.id)).toBe(WalletStatus.FROZEN)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(PLAN_PRICE)
  })

  it('E5 freeze does not reopen a wallet closed after its read', async () => {
    // R15: red without the status in the WHERE of freeze: the closed wallet ends up frozen.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    landAfterNextRead(repo, () => a.wallet.close(wallet.id))

    await expect(a.wallet.freeze(wallet.id)).rejects.toMatchObject({ code: 'WALLET_CLOSED' })

    expect(await statusOf(wallet.id)).toBe(WalletStatus.CLOSED)
  })

  it('E6 unfreeze does not reopen a wallet closed after its read', async () => {
    // R15: red without the status in the WHERE of unfreeze: the closed wallet ends up active.
    const wallet = await seedFrozen(0)
    landAfterNextRead(repo, () => a.wallet.close(wallet.id))

    await expect(a.wallet.unfreeze(wallet.id)).rejects.toMatchObject({ code: 'WALLET_NOT_FROZEN' })

    expect(await statusOf(wallet.id)).toBe(WalletStatus.CLOSED)
  })

  it('E7 the admin toggle freezes and keeps a credit that landed after its read', async () => {
    // R15: red when the toggle saves the row it read: the balance goes back to 0.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    landAfterNextRead(repo, () => credit(wallet.id))

    const result = await admin.toggleFreezeWallet(wallet.id)

    expect(await statusOf(wallet.id)).toBe(WalletStatus.FROZEN)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(PLAN_PRICE)
    expect(Number(result.data!.balance)).toBe(PLAN_PRICE)
    expect(await auditActions(wallet.id)).toEqual(['wallet_frozen'])
  })

  it('E8 the admin toggle unfreezes and keeps a credit that landed after its read', async () => {
    // R15: red when the toggle saves the row it read: the balance goes back to 0.
    const wallet = await seedFrozen(0)
    landAfterNextRead(repo, () => credit(wallet.id))

    await admin.toggleFreezeWallet(wallet.id)

    expect(await statusOf(wallet.id)).toBe(WalletStatus.ACTIVE)
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(PLAN_PRICE)
    expect(await auditActions(wallet.id)).toEqual(['wallet_unfrozen'])
  })

  it('E9 the admin toggle does not reopen a wallet closed after its read', async () => {
    // R15: red without the status in the WHERE of the toggle: the closed wallet ends up frozen.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    landAfterNextRead(repo, () => a.wallet.close(wallet.id))

    const result = await admin.toggleFreezeWallet(wallet.id)

    expect(result.error).toEqual(expect.any(String))
    expect(await statusOf(wallet.id)).toBe(WalletStatus.CLOSED)
    expect(await auditActions(wallet.id)).toEqual([])
  })

  it('E10 two admin toggles that read the same status record one change', async () => {
    // R15: red without the status in the WHERE of the toggle: a second audit row, same status.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    landAfterNextRead(repo, () => admin.toggleFreezeWallet(wallet.id))

    const result = await admin.toggleFreezeWallet(wallet.id)

    expect(result.error).toEqual(expect.any(String))
    expect(await statusOf(wallet.id)).toBe(WalletStatus.FROZEN)
    expect(await auditActions(wallet.id)).toEqual(['wallet_frozen'])
  })
})
