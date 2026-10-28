import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'
import { Wallet, WalletStatus } from './entities/wallet.entity'
import {
  Transaction,
  TransactionType,
  TransactionStatus,
} from '../transaction/entities/transaction.entity'
import { RequestException } from '../shared/exception/request.exception'
import { HttpStatus } from '@nestjs/common'

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name)

  constructor(
    @InjectRepository(Wallet, 'DBWrite')
    private readonly walletRepository: Repository<Wallet>,
    @InjectRepository(Wallet, 'DBRead')
    private readonly walletReadRepository: Repository<Wallet>,
    @InjectRepository(Transaction, 'DBWrite')
    private readonly transactionRepository: Repository<Transaction>,
    @InjectRepository(Transaction, 'DBRead')
    private readonly transactionReadRepository: Repository<Transaction>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Listar todas las wallets de una marca
   */
  async findByBrand(brandId: string) {
    try {
      const wallets = await this.walletReadRepository.find({
        where: { brandId },
        order: { createdAt: 'DESC' },
      })
      return { data: wallets }
    } catch (error) {
      this.logger.error(`Error al obtener wallets de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Obtener detalle de una wallet por ID
   */
  async findById(id: string) {
    try {
      const wallet = await this.walletReadRepository.findOne({ where: { id } })
      if (!wallet) {
        throw new RequestException(
          { code: 'WALLET_NOT_FOUND', message: 'Wallet no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }
      return { data: wallet }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al obtener wallet ${id}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Crear una wallet nueva.
   * Máximo 10 wallets por marca.
   */
  async create(data: Partial<Wallet>) {
    try {
      // Validar límite de 10 wallets por marca
      const count = await this.walletReadRepository.count({
        where: { brandId: data.brandId },
      })
      if (count >= 10) {
        throw new RequestException(
          { code: 'MAX_WALLETS', message: 'Máximo 10 wallets por marca' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      const wallet = this.walletRepository.create(this.sanitizeNewWallet(data))
      const saved = await this.walletRepository.save(wallet)
      this.logger.log(`Wallet creada: ${saved.id} para marca ${saved.brandId}`)
      return { data: saved }
    } catch (error) {
      if (error instanceof RequestException) throw error
      this.logger.error(`Error al crear wallet: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Acreditar fondos a una wallet con bloqueo pesimista.
   * Operación atómica: actualiza balance y crea transacción.
   */
  async credit(
    walletId: string,
    amount: number,
    data: Partial<Transaction> | string = {},
    idempotencyKey?: string,
  ) {
    const { txData, resolvedKey } = this.normalizeMovementData(data, idempotencyKey)
    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()

    try {
      // Bloqueo pesimista para evitar condiciones de carrera
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { id: walletId },
        lock: { mode: 'pessimistic_write' },
      })

      if (!wallet) {
        throw new RequestException(
          { code: 'WALLET_NOT_FOUND', message: 'Wallet no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      // Wallet cerrada no acepta ninguna operación
      if (wallet.status === WalletStatus.CLOSED) {
        throw new RequestException(
          { code: 'WALLET_CLOSED', message: 'Wallet cerrada, no acepta operaciones' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      const numericAmount = Number(amount)
      const balanceBefore = Number(wallet.balance)
      const balanceAfter = balanceBefore + numericAmount

      // Actualizar balance
      wallet.balance = balanceAfter
      await queryRunner.manager.save(Wallet, wallet)

      // Crear transacción
      const transaction = queryRunner.manager.create(Transaction, {
        walletId,
        brandId: wallet.brandId,
        type: TransactionType.CREDIT,
        amount: numericAmount,
        balanceBefore,
        balanceAfter,
        status: TransactionStatus.COMPLETED,
        ...txData,
      })
      const savedTransaction = await queryRunner.manager.save(Transaction, transaction)

      await queryRunner.commitTransaction()

      this.logger.log(
        `Crédito de ${amount} a wallet ${walletId}. Balance: ${balanceBefore} → ${balanceAfter}`,
      )
      return { data: { wallet, transaction: savedTransaction } }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      if (resolvedKey && this.isUniqueConstraintViolation(error)) {
        const existing = await this.findExistingMovement(queryRunner, walletId, resolvedKey)
        if (existing) return { data: existing }
      }
      if (error instanceof RequestException) throw error
      this.logger.error(`Error en crédito a wallet ${walletId}: ${error.message}`)
      return { error: error.message }
    } finally {
      await queryRunner.release()
    }
  }

  /**
   * Atomically debits `amount` from `walletId` under a `pessimistic_write` row lock
   * and records the corresponding `DEBIT` transaction.
   *
   * When `idempotencyKey` (or `data.idempotencyKey`) is provided, looks up an
   * existing movement by `idempotencyKey` alone (`findExistingMovement`) and, if
   * found, returns that movement as recorded along with the wallet of that
   * transaction (`existingTransaction.walletId || walletId`) without charging
   * again. Rejects `TKN` wallets or charges, brand ownership mismatches when
   * `data.brandId` is supplied, frozen or closed wallets, and currency
   * mismatches when `expectedCurrency` is provided (used by checkout and wallet
   * subscription renewals).
   *
   * @param walletId Target wallet identifier.
   * @param amount Positive finite debit amount in the wallet currency.
   * @param data Transaction metadata or referenceId string.
   * @param expectedCurrency Expected ISO currency code for the charge; when provided
   * and different from `wallet.currency`, throws `WALLET_CURRENCY_MISMATCH` (422).
   * @param idempotencyKey Optional key looked up by key alone to return a repeated
   * movement as recorded.
   */
  async debit(
    walletId: string,
    amount: number,
    data: Partial<Transaction> | string = {},
    expectedCurrency?: string,
    idempotencyKey?: string,
  ) {
    if (typeof walletId !== 'string' || !walletId.trim()) {
      throw new RequestException(
        { code: 'MISSING_WALLET_ID', message: 'walletId is required' },
        HttpStatus.BAD_REQUEST,
      )
    }

    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new RequestException(
        { code: 'INVALID_AMOUNT', message: 'Amount must be a finite number greater than zero' },
        HttpStatus.BAD_REQUEST,
      )
    }

    const { txData, resolvedKey } = this.normalizeMovementData(data, idempotencyKey)
    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()

    try {
      // Bloqueo pesimista para evitar condiciones de carrera
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { id: walletId },
        lock: { mode: 'pessimistic_write' },
      })

      if (resolvedKey) {
        const existing = await this.findExistingMovement(queryRunner, walletId, resolvedKey, wallet)
        if (existing) {
          await queryRunner.rollbackTransaction()
          return { data: existing }
        }
      }

      if (!wallet) {
        throw new RequestException(
          { code: 'WALLET_NOT_FOUND', message: 'Wallet no encontrada' },
          HttpStatus.NOT_FOUND,
        )
      }

      if ('brandId' in txData && (!txData.brandId || wallet.brandId !== txData.brandId)) {
        throw new RequestException(
          { code: 'WALLET_NOT_FOUND', message: 'Wallet does not belong to the paying brand' },
          HttpStatus.NOT_FOUND,
        )
      }

      const walletCurrency = wallet.currency?.toUpperCase()
      const requestedCurrency = expectedCurrency?.toUpperCase()
      if (walletCurrency === 'TKN' || requestedCurrency === 'TKN') {
        throw new RequestException(
          {
            code: 'WALLET_CURRENCY_MISMATCH',
            message: 'Token wallets cannot be debited for monetary charges',
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      // Re-check currency under the `pessimistic_write` row lock because checkout
      // pre-validates on the read replica outside this transaction.
      if (expectedCurrency && wallet.currency !== expectedCurrency) {
        throw new RequestException(
          {
            code: 'WALLET_CURRENCY_MISMATCH',
            message: `La wallet está en ${wallet.currency} y el cobro es en ${expectedCurrency}`,
          },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      // Wallet congelada o cerrada no permite débitos
      if (wallet.status === WalletStatus.FROZEN) {
        throw new RequestException(
          { code: 'WALLET_FROZEN', message: 'Wallet congelada, no permite débitos' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      if (wallet.status === WalletStatus.CLOSED) {
        throw new RequestException(
          { code: 'WALLET_CLOSED', message: 'Wallet cerrada, no acepta operaciones' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      const numericAmount = Number(amount)
      const balanceBefore = Number(wallet.balance)
      const balanceAfter = balanceBefore - numericAmount

      // Verificar saldo suficiente
      if (balanceAfter < 0) {
        if (resolvedKey) {
          const existing = await this.findExistingMovement(queryRunner, walletId, resolvedKey)
          if (existing) {
            await queryRunner.rollbackTransaction()
            return { data: existing }
          }
        }
        throw new RequestException(
          { code: 'INSUFFICIENT_BALANCE', message: 'Saldo insuficiente' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      // Actualizar balance
      wallet.balance = balanceAfter
      await queryRunner.manager.save(Wallet, wallet)

      // Crear transacción
      const transaction = queryRunner.manager.create(Transaction, {
        walletId,
        brandId: wallet.brandId,
        type: TransactionType.DEBIT,
        amount: numericAmount,
        balanceBefore,
        balanceAfter,
        status: TransactionStatus.COMPLETED,
        ...txData,
      })
      const savedTransaction = await queryRunner.manager.save(Transaction, transaction)

      await queryRunner.commitTransaction()

      this.logger.log(
        `Débito de ${amount} de wallet ${walletId}. Balance: ${balanceBefore} → ${balanceAfter}`,
      )
      return { data: { wallet, transaction: savedTransaction } }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      if (resolvedKey && this.isUniqueConstraintViolation(error)) {
        const existing = await this.findExistingMovement(queryRunner, walletId, resolvedKey)
        if (existing) return { data: existing }
      }
      if (error instanceof RequestException) throw error
      this.logger.error(`Error en débito de wallet ${walletId}: ${error.message}`)
      throw error
    } finally {
      await queryRunner.release()
    }
  }

  private normalizeMovementData(
    data: Partial<Transaction> | string = {},
    idempotencyKey?: string,
  ): { txData: Partial<Transaction>; resolvedKey?: string } {
    const txData: Partial<Transaction> =
      typeof data === 'string' ? { idempotencyKey: data } : { ...data }
    const resolvedKey = idempotencyKey ?? txData.idempotencyKey
    if (resolvedKey !== undefined) {
      txData.idempotencyKey = resolvedKey
    }
    return { txData, resolvedKey }
  }

  private isUniqueConstraintViolation(error: any): boolean {
    return error?.code === '23505' || error?.driverError?.code === '23505'
  }

  async findDebitByIdempotencyKey(
    walletId: string,
    idempotencyKey: string,
  ): Promise<Transaction | null> {
    if (!idempotencyKey) return null

    const readMatch = await this.transactionReadRepository?.findOne({
      where: { idempotencyKey },
    })
    if (readMatch && readMatch.idempotencyKey === idempotencyKey) {
      return readMatch
    }

    const writeMatch = await this.transactionRepository?.findOne({
      where: { idempotencyKey },
    })
    if (writeMatch && writeMatch.idempotencyKey === idempotencyKey) {
      return writeMatch
    }

    if (typeof this.dataSource?.createQueryRunner === 'function') {
      const queryRunner = this.dataSource.createQueryRunner()
      await queryRunner.connect()
      try {
        const existing = await this.findExistingMovement(queryRunner, walletId, idempotencyKey)
        return existing?.transaction ?? null
      } finally {
        await queryRunner.release()
      }
    }

    return null
  }

  private async findExistingMovement(
    queryRunner: { manager: { findOne: DataSource['manager']['findOne'] } },
    walletId: string,
    idempotencyKey: string,
    fallbackWallet?: Wallet | null,
  ) {
    const existingTransaction = await queryRunner.manager.findOne(Transaction, {
      where: { idempotencyKey },
    })
    if (!existingTransaction || existingTransaction.idempotencyKey !== idempotencyKey) return null

    const currentWallet =
      (await queryRunner.manager.findOne(Wallet, {
        where: { id: existingTransaction.walletId || walletId },
      })) ?? fallbackWallet
    if (currentWallet) {
      currentWallet.balance = Number(currentWallet.balance)
    }
    existingTransaction.amount = Number(existingTransaction.amount)
    existingTransaction.balanceBefore = Number(existingTransaction.balanceBefore)
    existingTransaction.balanceAfter = Number(existingTransaction.balanceAfter)

    return {
      wallet: currentWallet,
      transaction: existingTransaction,
    }
  }

  /**
   * Balance global: suma de todas las wallets activas de una marca, agrupado por moneda.
   */
  async getGlobalBalance(brandId: string) {
    try {
      const wallets = await this.walletReadRepository.find({
        where: { brandId, status: WalletStatus.ACTIVE },
      })

      // Agrupar por moneda
      const balanceByCurrency = new Map<string, { total: number; wallets: any[] }>()

      for (const wallet of wallets) {
        const entry = balanceByCurrency.get(wallet.currency) || { total: 0, wallets: [] }
        const balance = Number(wallet.balance)
        entry.total += balance
        entry.wallets.push({
          id: wallet.id,
          provider: wallet.provider,
          label: wallet.label || null,
          balance,
        })
        balanceByCurrency.set(wallet.currency, entry)
      }

      const balances = Array.from(balanceByCurrency.entries()).map(([currency, data]) => ({
        currency,
        total: Math.round(data.total * 100) / 100,
        wallets: data.wallets,
      }))

      return { data: { balances } }
    } catch (error) {
      this.logger.error(`Error al obtener balance global de marca ${brandId}: ${error.message}`)
      return { error: error.message }
    }
  }

  /**
   * Obtener transacciones de una wallet con paginación
   */
  async getTransactions(
    walletId: string,
    filters: { page?: number; limit?: number; type?: string } = {},
  ) {
    try {
      const { page = 1, limit = 20, type } = filters
      const skip = (page - 1) * limit

      const where: any = { walletId }
      if (type) where.type = type

      const [transactions, total] = await this.transactionReadRepository.findAndCount({
        where,
        order: { createdAt: 'DESC' },
        skip,
        take: limit,
      })

      return {
        data: transactions,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      }
    } catch (error) {
      this.logger.error(`Error al obtener transacciones de wallet ${walletId}: ${error.message}`)
      return { error: error.message }
    }
  }

  // =============================================================
  // Freeze / Close
  // =============================================================

  /**
   * Congelar wallet — bloquea débitos, permite créditos.
   */
  async freeze(walletId: string) {
    const wallet = await this.walletRepository.findOne({ where: { id: walletId } })
    if (!wallet) {
      throw new RequestException(
        { code: 'WALLET_NOT_FOUND', message: 'Wallet no encontrada' },
        HttpStatus.NOT_FOUND,
      )
    }
    if (wallet.status === WalletStatus.CLOSED) {
      throw new RequestException(
        { code: 'WALLET_CLOSED', message: 'No se puede congelar una wallet cerrada' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    wallet.status = WalletStatus.FROZEN
    await this.walletRepository.save(wallet)
    this.logger.log(`Wallet ${walletId} congelada`)
    return { data: wallet }
  }

  /**
   * Descongelar wallet — volver a estado activo.
   */
  async unfreeze(walletId: string) {
    const wallet = await this.walletRepository.findOne({ where: { id: walletId } })
    if (!wallet) {
      throw new RequestException(
        { code: 'WALLET_NOT_FOUND', message: 'Wallet no encontrada' },
        HttpStatus.NOT_FOUND,
      )
    }
    if (wallet.status !== WalletStatus.FROZEN) {
      throw new RequestException(
        { code: 'WALLET_NOT_FROZEN', message: 'Solo se pueden descongelar wallets congeladas' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    wallet.status = WalletStatus.ACTIVE
    await this.walletRepository.save(wallet)
    this.logger.log(`Wallet ${walletId} descongelada`)
    return { data: wallet }
  }

  /**
   * Cerrar wallet — requiere balance 0, bloquea todas las operaciones.
   */
  async close(walletId: string) {
    const wallet = await this.walletRepository.findOne({ where: { id: walletId } })
    if (!wallet) {
      throw new RequestException(
        { code: 'WALLET_NOT_FOUND', message: 'Wallet no encontrada' },
        HttpStatus.NOT_FOUND,
      )
    }
    if (Number(wallet.balance) !== 0) {
      throw new RequestException(
        {
          code: 'WALLET_HAS_BALANCE',
          message: 'No se puede cerrar una wallet con saldo. Transfiera el saldo primero.',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    wallet.status = WalletStatus.CLOSED
    await this.walletRepository.save(wallet)
    this.logger.log(`Wallet ${walletId} cerrada`)
    return { data: wallet }
  }

  // =============================================================
  // Transferencias entre wallets
  // =============================================================

  /**
   * Transferir fondos entre wallets de la misma marca y moneda.
   * Operación atómica con doble pessimistic lock.
   */
  async transfer(data: {
    fromWalletId: string
    toWalletId: string
    amount: number
    description?: string
    userId?: string
  }) {
    const { fromWalletId, toWalletId, amount, description } = data

    if (fromWalletId === toWalletId) {
      throw new RequestException(
        { code: 'SAME_WALLET', message: 'No se puede transferir a la misma wallet' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    if (amount <= 0) {
      throw new RequestException(
        { code: 'INVALID_AMOUNT', message: 'El monto debe ser mayor a 0' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()

    try {
      // Lock en orden determinista para evitar deadlocks
      const [firstId, secondId] =
        fromWalletId < toWalletId ? [fromWalletId, toWalletId] : [toWalletId, fromWalletId]

      const first = await queryRunner.manager.findOne(Wallet, {
        where: { id: firstId },
        lock: { mode: 'pessimistic_write' },
      })
      const second = await queryRunner.manager.findOne(Wallet, {
        where: { id: secondId },
        lock: { mode: 'pessimistic_write' },
      })

      const fromWallet = firstId === fromWalletId ? first : second
      const toWallet = firstId === toWalletId ? first : second

      if (!fromWallet || !toWallet) {
        throw new RequestException(
          { code: 'WALLET_NOT_FOUND', message: 'Una o ambas wallets no encontradas' },
          HttpStatus.NOT_FOUND,
        )
      }

      // Validar misma marca y moneda
      if (fromWallet.brandId !== toWallet.brandId) {
        throw new RequestException(
          { code: 'DIFFERENT_BRAND', message: 'Las wallets deben ser de la misma marca' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      if (fromWallet.currency !== toWallet.currency) {
        throw new RequestException(
          { code: 'DIFFERENT_CURRENCY', message: 'Las wallets deben tener la misma moneda' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      // Validar estados
      if (fromWallet.status !== WalletStatus.ACTIVE) {
        throw new RequestException(
          { code: 'WALLET_NOT_ACTIVE', message: 'La wallet origen debe estar activa' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      if (toWallet.status === WalletStatus.CLOSED) {
        throw new RequestException(
          { code: 'WALLET_CLOSED', message: 'La wallet destino está cerrada' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      // Validar saldo
      const fromBalance = Number(fromWallet.balance)
      if (fromBalance < amount) {
        throw new RequestException(
          { code: 'INSUFFICIENT_BALANCE', message: 'Saldo insuficiente en wallet origen' },
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }

      // Debitar origen
      const fromBalanceAfter = fromBalance - amount
      fromWallet.balance = fromBalanceAfter
      await queryRunner.manager.save(Wallet, fromWallet)

      const debitTx = queryRunner.manager.create(Transaction, {
        walletId: fromWalletId,
        brandId: fromWallet.brandId,
        type: TransactionType.DEBIT,
        amount,
        balanceBefore: fromBalance,
        balanceAfter: fromBalanceAfter,
        status: TransactionStatus.COMPLETED,
        category: 'transfer_out',
        description: description || `Transferencia a wallet ${toWalletId}`,
        referenceType: 'transfer',
        referenceId: toWalletId,
      })
      await queryRunner.manager.save(Transaction, debitTx)

      // Acreditar destino
      const toBalance = Number(toWallet.balance)
      const toBalanceAfter = toBalance + amount
      toWallet.balance = toBalanceAfter
      await queryRunner.manager.save(Wallet, toWallet)

      const creditTx = queryRunner.manager.create(Transaction, {
        walletId: toWalletId,
        brandId: toWallet.brandId,
        type: TransactionType.CREDIT,
        amount,
        balanceBefore: toBalance,
        balanceAfter: toBalanceAfter,
        status: TransactionStatus.COMPLETED,
        category: 'transfer_in',
        description: description || `Transferencia desde wallet ${fromWalletId}`,
        referenceType: 'transfer',
        referenceId: fromWalletId,
      })
      await queryRunner.manager.save(Transaction, creditTx)

      await queryRunner.commitTransaction()

      this.logger.log(
        `Transferencia de ${amount} ${fromWallet.currency}: wallet ${fromWalletId} → ${toWalletId}`,
      )
      return {
        data: {
          fromWallet: { id: fromWalletId, balanceAfter: fromBalanceAfter },
          toWallet: { id: toWalletId, balanceAfter: toBalanceAfter },
          amount,
          currency: fromWallet.currency,
        },
      }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      if (error instanceof RequestException) throw error
      this.logger.error(`Error en transferencia: ${error.message}`)
      return { error: error.message }
    } finally {
      await queryRunner.release()
    }
  }

  private sanitizeNewWallet(data: Partial<Wallet>): Partial<Wallet> {
    return {
      brandId: data.brandId,
      userId: data.userId,
      provider: data.provider,
      providerWalletId: data.providerWalletId,
      currency: data.currency,
      label: data.label,
      metadata: data.metadata,
      balance: 0,
      status: WalletStatus.ACTIVE,
    }
  }
}
