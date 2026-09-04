import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm'
import { Repository, DataSource } from 'typeorm'
import { Wallet, WalletStatus } from './entities/wallet.entity'
import { WalletBalanceSnapshot } from './entities/walletBalanceSnapshot.entity'
import { Transaction, TransactionType, TransactionStatus } from '../transaction/entities/transaction.entity'
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

      const wallet = this.walletRepository.create(data)
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
  async credit(walletId: string, amount: number, data: Partial<Transaction> = {}) {
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

      const balanceBefore = Number(wallet.balance)
      const balanceAfter = balanceBefore + Number(amount)

      // Actualizar balance
      wallet.balance = balanceAfter
      await queryRunner.manager.save(Wallet, wallet)

      // Crear transacción
      const transaction = queryRunner.manager.create(Transaction, {
        walletId,
        brandId: wallet.brandId,
        type: TransactionType.CREDIT,
        amount,
        balanceBefore,
        balanceAfter,
        status: TransactionStatus.COMPLETED,
        ...data,
      })
      const savedTransaction = await queryRunner.manager.save(Transaction, transaction)

      await queryRunner.commitTransaction()

      this.logger.log(`Crédito de ${amount} a wallet ${walletId}. Balance: ${balanceBefore} → ${balanceAfter}`)
      return { data: { wallet, transaction: savedTransaction } }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      if (error instanceof RequestException) throw error
      this.logger.error(`Error en crédito a wallet ${walletId}: ${error.message}`)
      return { error: error.message }
    } finally {
      await queryRunner.release()
    }
  }

  /**
   * Debitar fondos de una wallet con bloqueo pesimista.
   * Verifica saldo suficiente antes de debitar.
   * Operación atómica: actualiza balance y crea transacción.
   *
   * @param expectedCurrency moneda en la que se está cobrando. Opcional: si se pasa y no
   * coincide con la de la wallet, rechaza con `WALLET_CURRENCY_MISMATCH` (422) sin dejar
   * movimiento. Omitirlo mantiene el comportamiento histórico (lo hace el cron de
   * renovación, `tasks.service.ts:renewFromWallet`, que sigue sin guarda de moneda).
   */
  async debit(
    walletId: string,
    amount: number,
    data: Partial<Transaction> = {},
    expectedCurrency?: string,
  ) {
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

      // La guarda de moneda va ACÁ y no sólo en checkout: `assertWalletCurrency`
      // (checkout.service.ts) lee la wallet por la réplica DBRead y FUERA de todo
      // bloqueo, así que entre esa comprobación y este débito hay una ventana. Este
      // punto corre sobre la fila ya tomada con `pessimistic_write` dentro de la
      // transacción abierta, y es el último cuello de botella antes de que se mueva
      // plata. Comparación estricta, igual que `assertWalletCurrency` y `transfer`.
      // `credit`, `transfer` y el cron `renewFromWallet` NO llevan esta guarda a
      // propósito: `transfer` ya compara las monedas de las dos wallets, y sumarla al
      // cron cambiaría renovaciones que hoy pasan.
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

      const balanceBefore = Number(wallet.balance)
      const balanceAfter = balanceBefore - Number(amount)

      // Verificar saldo suficiente
      if (balanceAfter < 0) {
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
        amount,
        balanceBefore,
        balanceAfter,
        status: TransactionStatus.COMPLETED,
        ...data,
      })
      const savedTransaction = await queryRunner.manager.save(Transaction, transaction)

      await queryRunner.commitTransaction()

      this.logger.log(`Débito de ${amount} de wallet ${walletId}. Balance: ${balanceBefore} → ${balanceAfter}`)
      return { data: { wallet, transaction: savedTransaction } }
    } catch (error) {
      await queryRunner.rollbackTransaction()
      if (error instanceof RequestException) throw error
      this.logger.error(`Error en débito de wallet ${walletId}: ${error.message}`)
      return { error: error.message }
    } finally {
      await queryRunner.release()
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
  async getTransactions(walletId: string, filters: { page?: number; limit?: number; type?: string } = {}) {
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
        { code: 'WALLET_HAS_BALANCE', message: 'No se puede cerrar una wallet con saldo. Transfiera el saldo primero.' },
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
      const [firstId, secondId] = fromWalletId < toWalletId
        ? [fromWalletId, toWalletId]
        : [toWalletId, fromWalletId]

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

      this.logger.log(`Transferencia de ${amount} ${fromWallet.currency}: wallet ${fromWalletId} → ${toWalletId}`)
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
}
