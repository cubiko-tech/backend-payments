import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import {
  cleanBrand,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7101005-2222-4333-8444-555555555555'

describe('Closing a wallet while a credit lands (PostgreSQL, LOC-104)', () => {
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

  it('E11 refuses to close a wallet that took a credit after the balance was read', async () => {
    // R15: red without the balance in the WHERE: closed holding the money just credited.
    const wallet = await seedWallet(a.dataSource, BRAND_ID, 0)
    const repo = (a.wallet as any).walletRepository
    const update = repo.update.bind(repo)
    // R17: Only a forced pause lands the credit between the read and the write of the close.
    jest.spyOn(repo, 'update').mockImplementationOnce(async (...args: any[]) => {
      await a.wallet.credit(wallet.id, PLAN_PRICE, { brandId: BRAND_ID, category: 'refund' })
      return update(...args)
    })

    await expect(a.wallet.close(wallet.id)).rejects.toMatchObject({ code: 'WALLET_HAS_BALANCE' })

    const row = await a.dataSource.getRepository(Wallet).findOneByOrFail({ id: wallet.id })
    expect(row.status).toBe(WalletStatus.ACTIVE)
    expect(Number(row.balance)).toBe(PLAN_PRICE)
  })
})
