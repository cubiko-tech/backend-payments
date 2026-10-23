import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { config as dotenvConfig } from 'dotenv'
import { DataSource } from 'typeorm'
import { randomUUID } from 'crypto'
import { WalletService } from '../src/wallet/wallet.service'
import { Wallet, WalletStatus } from '../src/wallet/entities/wallet.entity'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { AddTransactionIdempotencyKey1792728404940 } from '../migrations/1792728404940-AddTransactionIdempotencyKey'

dotenvConfig({ path: '.env' })

describe('WalletService idempotent movements (e2e)', () => {
  let moduleRef: TestingModule
  let dataSource: DataSource
  let walletService: WalletService
  const createdWalletIds: string[] = []

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.POSTGRES_HOST,
      port: Number(process.env.POSTGRES_PORT),
      username: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
      database: process.env.POSTGRES_DB,
      entities: [Wallet, Transaction],
      synchronize: false,
    })
    await dataSource.initialize()

    const walletRepository = dataSource.getRepository(Wallet)
    const transactionRepository = dataSource.getRepository(Transaction)

    moduleRef = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: getRepositoryToken(Wallet, 'DBWrite'), useValue: walletRepository },
        { provide: getRepositoryToken(Wallet, 'DBRead'), useValue: walletRepository },
        { provide: getRepositoryToken(Transaction, 'DBWrite'), useValue: transactionRepository },
        { provide: getRepositoryToken(Transaction, 'DBRead'), useValue: transactionRepository },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
      ],
    }).compile()

    walletService = moduleRef.get(WalletService)
  })

  afterEach(async () => {
    if (createdWalletIds.length > 0) {
      await dataSource
        .getRepository(Transaction)
        .createQueryBuilder()
        .delete()
        .where('"walletId" IN (:...ids)', { ids: createdWalletIds })
        .execute()
      await dataSource
        .getRepository(Wallet)
        .createQueryBuilder()
        .delete()
        .where('id IN (:...ids)', { ids: createdWalletIds })
        .execute()
      createdWalletIds.length = 0
    }
  })

  afterAll(async () => {
    if (moduleRef) {
      await moduleRef.close()
    }
    if (dataSource?.isInitialized) {
      await dataSource.destroy()
    }
  })

  async function createTestWallet(initialBalance: number): Promise<Wallet> {
    const wallet = await dataSource.getRepository(Wallet).save(
      dataSource.getRepository(Wallet).create({
        brandId: `brand-${randomUUID()}`,
        userId: `user-${randomUUID()}`,
        provider: 'internal',
        currency: 'COP',
        balance: initialBalance,
        status: WalletStatus.ACTIVE,
      }),
    )
    createdWalletIds.push(wallet.id)
    return wallet
  }

  it('does not move the balance a second time and returns the original movement when repeating credit with k1', async () => {
    const wallet = await createTestWallet(100)
    const key = `k1-${randomUUID()}`

    const first = await walletService.credit(wallet.id, 50, {
      category: 'recharge',
      description: 'First credit with k1',
      idempotencyKey: key,
    })
    const second = await walletService.credit(wallet.id, 50, {
      category: 'recharge',
      description: 'Repeated credit with k1',
      idempotencyKey: key,
    })

    const persistedWallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ id: wallet.id })
    const transactions = await dataSource
      .getRepository(Transaction)
      .find({ where: { walletId: wallet.id } })

    expect(Number(persistedWallet.balance)).toBe(150)
    expect(transactions).toHaveLength(1)
    expect(second.data?.transaction.id).toBe(first.data?.transaction.id)
    expect(second.data?.transaction.balanceBefore).toBe(100)
    expect(second.data?.transaction.balanceAfter).toBe(150)
    expect(second.data?.wallet?.balance).toBe(150)
  })

  it('does not move the balance a second time and returns the original movement when repeating debit with k2', async () => {
    const wallet = await createTestWallet(200)
    const key = `k2-${randomUUID()}`

    const first = await walletService.debit(wallet.id, 60, {
      category: 'plan_payment',
      description: 'First debit with k2',
      idempotencyKey: key,
    })
    const second = await walletService.debit(wallet.id, 60, {
      category: 'plan_payment',
      description: 'Repeated debit with k2',
      idempotencyKey: key,
    })

    const persistedWallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ id: wallet.id })
    const transactions = await dataSource
      .getRepository(Transaction)
      .find({ where: { walletId: wallet.id } })

    expect(Number(persistedWallet.balance)).toBe(140)
    expect(transactions).toHaveLength(1)
    expect(second.data?.transaction.id).toBe(first.data?.transaction.id)
    expect(second.data?.transaction.balanceBefore).toBe(200)
    expect(second.data?.transaction.balanceAfter).toBe(140)
    expect(second.data?.wallet?.balance).toBe(140)
  })

  it('moves the balance twice when using distinct keys k3 and k4', async () => {
    const wallet = await createTestWallet(100)
    const k3 = `k3-${randomUUID()}`
    const k4 = `k4-${randomUUID()}`

    const first = await walletService.credit(wallet.id, 40, { idempotencyKey: k3 })
    const second = await walletService.credit(wallet.id, 40, { idempotencyKey: k4 })

    const persistedWallet = await dataSource
      .getRepository(Wallet)
      .findOneByOrFail({ id: wallet.id })
    const transactions = await dataSource
      .getRepository(Transaction)
      .find({ where: { walletId: wallet.id } })

    expect(Number(persistedWallet.balance)).toBe(180)
    expect(transactions).toHaveLength(2)
    expect(first.data?.transaction.id).not.toBe(second.data?.transaction.id)
  })

  it('reverts and reapplies the idempotencyKey migration cleanly', async () => {
    const migration = new AddTransactionIdempotencyKey1792728404940()
    const queryRunner = dataSource.createQueryRunner()
    await queryRunner.connect()

    try {
      await migration.down(queryRunner)
      const afterDown = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'idempotencyKey'`,
      )
      expect(afterDown).toHaveLength(0)

      await migration.up(queryRunner)
      const afterUp = await queryRunner.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'idempotencyKey'`,
      )
      expect(afterUp).toHaveLength(1)
    } finally {
      await queryRunner.release()
    }
  })
})
