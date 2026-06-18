import { Test, TestingModule } from '@nestjs/testing'
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm'
import { WalletService } from './wallet.service'
import { Wallet } from './entities/wallet.entity'
import { Transaction, TransactionType, TransactionStatus } from '../transaction/entities/transaction.entity'
import { RequestException } from '../shared/exception/request.exception'

const createMockRepo = () => ({
  find: jest.fn().mockResolvedValue([]),
  findOne: jest.fn().mockResolvedValue(null),
  findAndCount: jest.fn().mockResolvedValue([[], 0]),
  count: jest.fn().mockResolvedValue(0),
  create: jest.fn((data) => data),
  save: jest.fn((data) => Promise.resolve({ id: 'mock-id', ...data })),
  delete: jest.fn().mockResolvedValue({ affected: 1 }),
  update: jest.fn().mockResolvedValue({ affected: 1 }),
})

const mockQueryRunner = {
  connect: jest.fn(),
  startTransaction: jest.fn(),
  commitTransaction: jest.fn(),
  rollbackTransaction: jest.fn(),
  release: jest.fn(),
  manager: {
    findOne: jest.fn(),
    save: jest.fn((entity, data) => Promise.resolve({ id: 'mock-id', ...data })),
    create: jest.fn((entity, data) => data),
  },
}

describe('WalletService', () => {
  let service: WalletService
  let walletRepo: ReturnType<typeof createMockRepo>
  let walletReadRepo: ReturnType<typeof createMockRepo>
  let transactionRepo: ReturnType<typeof createMockRepo>
  let transactionReadRepo: ReturnType<typeof createMockRepo>

  beforeEach(async () => {
    walletRepo = createMockRepo()
    walletReadRepo = createMockRepo()
    transactionRepo = createMockRepo()
    transactionReadRepo = createMockRepo()

    // Resetear mocks del queryRunner
    Object.values(mockQueryRunner).forEach((fn) => {
      if (typeof fn === 'function') (fn as jest.Mock).mockReset()
    })
    mockQueryRunner.manager.findOne.mockReset()
    mockQueryRunner.manager.save.mockReset().mockImplementation((entity, data) =>
      Promise.resolve({ id: 'mock-id', ...data }),
    )
    mockQueryRunner.manager.create.mockReset().mockImplementation((entity, data) => data)

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletService,
        { provide: getRepositoryToken(Wallet, 'DBWrite'), useValue: walletRepo },
        { provide: getRepositoryToken(Wallet, 'DBRead'), useValue: walletReadRepo },
        { provide: getRepositoryToken(Transaction, 'DBWrite'), useValue: transactionRepo },
        { provide: getRepositoryToken(Transaction, 'DBRead'), useValue: transactionReadRepo },
        {
          provide: getDataSourceToken('DBWrite'),
          useValue: { createQueryRunner: () => mockQueryRunner },
        },
      ],
    }).compile()

    service = module.get<WalletService>(WalletService)
  })

  describe('findByBrand', () => {
    it('retorna las wallets de una marca', async () => {
      const wallets = [
        { id: 'w1', brandId: 'brand-1', balance: 100 },
        { id: 'w2', brandId: 'brand-1', balance: 50 },
      ]
      walletReadRepo.find.mockResolvedValue(wallets)

      const result = await service.findByBrand('brand-1')

      expect(result.data).toEqual(wallets)
      expect(walletReadRepo.find).toHaveBeenCalledWith({
        where: { brandId: 'brand-1' },
        order: { createdAt: 'DESC' },
      })
    })
  })

  describe('findById', () => {
    it('retorna el detalle de una wallet', async () => {
      const wallet = { id: 'w1', brandId: 'brand-1', balance: 100 }
      walletReadRepo.findOne.mockResolvedValue(wallet)

      const result = await service.findById('w1')

      expect(result.data).toEqual(wallet)
      expect(walletReadRepo.findOne).toHaveBeenCalledWith({ where: { id: 'w1' } })
    })

    it('lanza error si la wallet no existe', async () => {
      walletReadRepo.findOne.mockResolvedValue(null)

      await expect(service.findById('inexistente')).rejects.toThrow(RequestException)
    })
  })

  describe('create', () => {
    it('crea una wallet nueva', async () => {
      const data = { brandId: 'brand-1', userId: 'user-1', currency: 'USD' }
      walletRepo.create.mockReturnValue(data)
      walletRepo.save.mockResolvedValue({ id: 'w1', ...data })

      const result = await service.create(data)

      expect(result.data).toEqual({ id: 'w1', ...data })
      expect(walletRepo.create).toHaveBeenCalledWith(data)
      expect(walletRepo.save).toHaveBeenCalledWith(data)
    })
  })

  describe('credit', () => {
    it('acredita fondos atómicamente y crea transacción con balanceBefore/After', async () => {
      const wallet = { id: 'w1', brandId: 'brand-1', balance: 100 }
      mockQueryRunner.manager.findOne.mockResolvedValue(wallet)
      mockQueryRunner.manager.save
        .mockResolvedValueOnce(wallet) // save wallet
        .mockResolvedValueOnce({ id: 'tx1', walletId: 'w1', amount: 50, balanceBefore: 100, balanceAfter: 150 }) // save transaction

      const result = await service.credit('w1', 50)

      expect(mockQueryRunner.connect).toHaveBeenCalled()
      expect(mockQueryRunner.startTransaction).toHaveBeenCalled()

      // Verifica bloqueo pesimista
      expect(mockQueryRunner.manager.findOne).toHaveBeenCalledWith(Wallet, {
        where: { id: 'w1' },
        lock: { mode: 'pessimistic_write' },
      })

      // Verifica que el balance fue actualizado
      expect(wallet.balance).toBe(150)

      // Verifica que se creó la transacción con los valores correctos
      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(Transaction, expect.objectContaining({
        walletId: 'w1',
        brandId: 'brand-1',
        type: TransactionType.CREDIT,
        amount: 50,
        balanceBefore: 100,
        balanceAfter: 150,
        status: TransactionStatus.COMPLETED,
      }))

      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled()
      expect(mockQueryRunner.release).toHaveBeenCalled()
      expect(result.data).toBeDefined()
    })

    it('falla si la wallet no existe', async () => {
      mockQueryRunner.manager.findOne.mockResolvedValue(null)

      await expect(service.credit('inexistente', 50)).rejects.toThrow(RequestException)
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled()
      expect(mockQueryRunner.release).toHaveBeenCalled()
    })
  })

  describe('debit', () => {
    it('debita fondos atómicamente y crea transacción', async () => {
      const wallet = { id: 'w1', brandId: 'brand-1', balance: 200 }
      mockQueryRunner.manager.findOne.mockResolvedValue(wallet)
      mockQueryRunner.manager.save
        .mockResolvedValueOnce(wallet) // save wallet
        .mockResolvedValueOnce({ id: 'tx1', walletId: 'w1', amount: 80, balanceBefore: 200, balanceAfter: 120 })

      const result = await service.debit('w1', 80)

      expect(wallet.balance).toBe(120)
      expect(mockQueryRunner.manager.create).toHaveBeenCalledWith(Transaction, expect.objectContaining({
        type: TransactionType.DEBIT,
        amount: 80,
        balanceBefore: 200,
        balanceAfter: 120,
        status: TransactionStatus.COMPLETED,
      }))
      expect(mockQueryRunner.commitTransaction).toHaveBeenCalled()
      expect(result.data).toBeDefined()
    })

    it('lanza error si el saldo es insuficiente', async () => {
      const wallet = { id: 'w1', brandId: 'brand-1', balance: 30 }
      mockQueryRunner.manager.findOne.mockResolvedValue(wallet)

      await expect(service.debit('w1', 100)).rejects.toThrow(RequestException)
      expect(mockQueryRunner.rollbackTransaction).toHaveBeenCalled()
      expect(mockQueryRunner.release).toHaveBeenCalled()
    })

    it('usa bloqueo pesimista en findOne', async () => {
      const wallet = { id: 'w1', brandId: 'brand-1', balance: 500 }
      mockQueryRunner.manager.findOne.mockResolvedValue(wallet)
      mockQueryRunner.manager.save.mockResolvedValue(wallet)

      await service.debit('w1', 100)

      expect(mockQueryRunner.manager.findOne).toHaveBeenCalledWith(Wallet, {
        where: { id: 'w1' },
        lock: { mode: 'pessimistic_write' },
      })
    })
  })

  describe('getTransactions', () => {
    it('retorna transacciones de una wallet con paginación', async () => {
      const transactions = [
        { id: 'tx1', walletId: 'w1', amount: 50, type: TransactionType.CREDIT },
        { id: 'tx2', walletId: 'w1', amount: 30, type: TransactionType.DEBIT },
      ]
      transactionReadRepo.findAndCount.mockResolvedValue([transactions, 2])

      const result = await service.getTransactions('w1', { page: 1, limit: 20 })

      expect(result.data).toEqual(transactions)
      expect(result.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 })
      expect(transactionReadRepo.findAndCount).toHaveBeenCalledWith({
        where: { walletId: 'w1' },
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 20,
      })
    })
  })
})
