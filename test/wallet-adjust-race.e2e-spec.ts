import { EntityManager } from 'typeorm'

import { AdminController } from '../src/admin/admin.controller'
import { AuditService } from '../src/audit/audit.service'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import {
  balanceOf,
  cleanBrand,
  RaceInstance,
  seedWallet,
  someoneWaitsOnRowLock,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7101100-2222-4333-8444-555555555555'
const START = 100
const ADJUST = 900
const MOVE = 20000

describe('Adjusting a wallet while its balance moves (PostgreSQL, LOC-110)', () => {
  let a: RaceInstance
  let b: RaceInstance
  let admin: AdminController

  const creditFromB = (walletId: string) =>
    b.wallet.credit(walletId, MOVE, { brandId: BRAND_ID, category: 'refund' })
  const debitFromB = (walletId: string, amount: number) =>
    b.wallet.debit(walletId, amount, { brandId: BRAND_ID, category: 'subscription' })
  const movementsOf = (walletId: string) =>
    a.dataSource.getRepository(Transaction).find({ where: { walletId } })
  const setStatus = (walletId: string, status: WalletStatus) =>
    a.dataSource.getRepository(Wallet).update({ id: walletId }, { status })

  /**
   * Starts `action` right after the adjustment reads the wallet row, and lets the adjustment go on
   * once `action` finished or is blocked on the row lock, the only two outcomes it can have.
   */
  function landAfterAdjustRead(action: () => Promise<unknown>) {
    const read = EntityManager.prototype.findOne
    let landed: Promise<unknown> = Promise.resolve()
    // R17: Only a forced pause lands a movement between the read and the write, whatever the write.
    jest.spyOn(EntityManager.prototype, 'findOne').mockImplementationOnce(async function (
      this: EntityManager,
      ...args: Parameters<EntityManager['findOne']>
    ) {
      const row = await read.apply(this, args)
      landed = action()
      await Promise.race([landed, someoneWaitsOnRowLock(a.dataSource)])
      return row
    } as EntityManager['findOne'])
    return () => landed
  }

  /** Holds the row lock from instance B while `work` runs, then commits what `write` did. */
  async function holdingRow(walletId: string, write: string, work: () => Promise<unknown>) {
    const other = b.dataSource.createQueryRunner()
    await other.connect()
    await other.startTransaction()
    try {
      await other.query('SELECT id FROM wallets WHERE id = $1 FOR UPDATE', [walletId])
      await other.query(write, [walletId])
      const pending = work()
      expect(await someoneWaitsOnRowLock(b.dataSource)).toBe(true)
      await other.commitTransaction()
      return await pending
    } finally {
      if (other.isTransactionActive) await other.rollbackTransaction()
      await other.release()
    }
  }

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
    const unused = null as any
    admin = new AdminController(
      unused,
      unused,
      unused,
      unused,
      unused,
      a.dataSource.getRepository(Wallet),
      unused,
      unused,
      unused,
      a.dataSource.getRepository(Transaction),
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

  it('A1 a credit adjustment and a concurrent credit both add up, with their transactions', async () => {
    // R15: red when the adjustment reads without the lock: it saves 1000 and loses the 20000.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, START)
    const landed = landAfterAdjustRead(() => creditFromB(wallet.id))

    const result = await admin.adjustWallet(wallet.id, { type: 'credit', amount: ADJUST })
    await landed()

    expect(result.error).toBeUndefined()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(START + ADJUST + MOVE)
    const adjustment = (await movementsOf(wallet.id)).find((m) => m.referenceType === 'admin')!
    expect(Number(adjustment.amount)).toBe(ADJUST)
    expect(Number(adjustment.balanceBefore)).toBe(START)
    expect(Number(adjustment.balanceAfter)).toBe(START + ADJUST)
    expect(await movementsOf(wallet.id)).toHaveLength(2)
  })

  it('A2 a debit adjustment and a concurrent credit both add up', async () => {
    // R15: red when the adjustment reads without the lock: the 20000 credit disappears.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, ADJUST)
    const landed = landAfterAdjustRead(() => creditFromB(wallet.id))

    await admin.adjustWallet(wallet.id, { type: 'debit', amount: ADJUST })
    await landed()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(MOVE)
    expect(await movementsOf(wallet.id)).toHaveLength(2)
  })

  it('A3 a credit adjustment does not bring back a concurrent debit', async () => {
    // R15: red when the adjustment reads without the lock: the debited money comes back.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, MOVE)
    const landed = landAfterAdjustRead(() => debitFromB(wallet.id, MOVE))

    await admin.adjustWallet(wallet.id, { type: 'credit', amount: ADJUST })
    await landed()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(ADJUST)
    expect(await movementsOf(wallet.id)).toHaveLength(2)
  })

  it('A4 two concurrent adjustments both add up', async () => {
    // R15: red when the adjustment reads without the lock: one of the two is lost.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, START)
    const landed = landAfterAdjustRead(() =>
      admin.adjustWallet(wallet.id, { type: 'credit', amount: MOVE }),
    )

    await admin.adjustWallet(wallet.id, { type: 'credit', amount: ADJUST })
    await landed()

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(START + ADJUST + MOVE)
  })

  it('A5 an adjustment waits for a movement another instance holds the row lock for', async () => {
    // R15: red when the adjustment reads without the lock: it starts from the stale 100.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, START)

    await holdingRow(
      wallet.id,
      `UPDATE wallets SET balance = balance + ${MOVE} WHERE id = $1`,
      () => admin.adjustWallet(wallet.id, { type: 'credit', amount: ADJUST }),
    )

    expect(await balanceOf(a.dataSource, wallet.id)).toBe(START + ADJUST + MOVE)
  })

  it('A6 an adjustment waiting on the row answers closed when the wallet closes meanwhile', async () => {
    // R15: red when the adjustment reads without the lock: the closed wallet takes the money.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)

    const result = await holdingRow(
      wallet.id,
      `UPDATE wallets SET status = 'closed' WHERE id = $1`,
      () => admin.adjustWallet(wallet.id, { type: 'credit', amount: ADJUST }),
    )

    expect(result).toEqual({ error: 'Wallet cerrada' })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(0)
    expect(await movementsOf(wallet.id)).toHaveLength(0)
  })

  it('A7 a debit waiting on the row answers frozen when the wallet freezes meanwhile', async () => {
    // R15: red when the adjustment reads without the lock: the frozen wallet gets debited.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, START)

    const result = await holdingRow(
      wallet.id,
      `UPDATE wallets SET status = 'frozen' WHERE id = $1`,
      () => admin.adjustWallet(wallet.id, { type: 'debit', amount: START }),
    )

    expect(result).toEqual({ error: 'Wallet congelada — no se permiten débitos' })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(START)
    expect(await movementsOf(wallet.id)).toHaveLength(0)
  })

  it('A8 a failed balance write leaves neither the balance nor the transaction', async () => {
    // R15: red when the two writes run outside one transaction: the transaction row stays.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, START)
    const save = EntityManager.prototype.save
    // R17: A healthy PostgreSQL does not fail this write on demand.
    jest.spyOn(EntityManager.prototype, 'save').mockImplementation(async function (
      this: EntityManager,
      ...args: unknown[]
    ) {
      if (args[0] === Wallet) throw new Error('write failed')
      return (save as (...all: unknown[]) => Promise<unknown>).apply(this, args)
    } as EntityManager['save'])

    await expect(admin.adjustWallet(wallet.id, { type: 'credit', amount: ADJUST })).rejects.toThrow(
      'write failed',
    )

    jest.restoreAllMocks()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(START)
    expect(await movementsOf(wallet.id)).toHaveLength(0)
  })

  it('A9 a closed wallet answers as before and does not move', async () => {
    // R15: red when the closed check goes away: the closed wallet takes the money.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    await setStatus(wallet.id, WalletStatus.CLOSED)

    const result = await admin.adjustWallet(wallet.id, { type: 'credit', amount: ADJUST })

    expect(result).toEqual({ error: 'Wallet cerrada' })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(0)
  })

  it('A10 a debit on a frozen wallet answers as before and a credit still enters', async () => {
    // R15: red when the frozen check goes away: the debit goes through.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, START)
    await setStatus(wallet.id, WalletStatus.FROZEN)

    const debit = await admin.adjustWallet(wallet.id, { type: 'debit', amount: START })
    const credit = await admin.adjustWallet(wallet.id, { type: 'credit', amount: ADJUST })

    expect(debit).toEqual({ error: 'Wallet congelada — no se permiten débitos' })
    expect(credit.error).toBeUndefined()
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(START + ADJUST)
  })

  it('A11 a debit over the balance answers as before, naming the balance', async () => {
    // R15: red when the funds check goes away: the balance goes negative.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, START)

    const result = await admin.adjustWallet(wallet.id, { type: 'debit', amount: ADJUST })

    expect(result).toEqual({ error: `Fondos insuficientes. Balance actual: ${START}` })
    expect(await balanceOf(a.dataSource, wallet.id)).toBe(START)
  })
})
