// R6: one responsibility, the token wallet's movement guard (`move`) and the movements that go
// through it; splitting them apart would expose `move` to callers that skip its lock and key.
import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm'
import { Wallet, WalletProvider, WalletStatus } from './entities/wallet.entity'
import {
  Transaction,
  TransactionStatus,
  TransactionType,
} from '../transaction/entities/transaction.entity'
import { RequestException } from '../shared/exception/request.exception'
import { isUniqueConstraintViolation } from '../checkout/checkout-idempotency'
import { TOKEN_CURRENCY, TokenOrigin, isTokenCurrency } from './token-origin'
import {
  TokenBuckets,
  fromCents,
  owedByDebit,
  planTokenRefund,
  planTokenSpend,
  toCents,
} from './token-spend'
import { MovementAudit } from '../transaction/movement-audit'
import {
  applyLimits,
  connectWithin,
  isLimitHit,
  MovementLimits,
  walletBusy,
} from './movement-limits'

const BUCKET_COLUMN: Record<TokenOrigin, 'giftTokens' | 'purchasedTokens' | 'dropiTokens'> = {
  [TokenOrigin.GIFT]: 'giftTokens',
  [TokenOrigin.PURCHASED]: 'purchasedTokens',
  [TokenOrigin.DROPI]: 'dropiTokens',
}

/** What a brand sees of its token wallet. `unassigned` is balance that no origin accounts for. */
export interface TokenWalletView {
  id: string
  brandId: string
  status: WalletStatus
  currency: string
  balance: number
  byOrigin: { gift: number; purchased: number; dropi: number }
  unassigned: number
}

export interface TokenMovement {
  wallet: TokenWalletView
  transaction: Transaction
  replayed: boolean
}

/** Brand-visible view of a token wallet movement: no description, metadata, referenceType or referenceId. */
export interface TokenWalletMovementView {
  id: string
  createdAt: Date
  type: TransactionType
  origin: string | null
  tokenSplit: { gift: number; purchased: number; dropi: number } | null
  amount: number
  balanceAfter: number
}

export interface TokenWalletMovementsPage {
  data: TokenWalletMovementView[]
  meta: { total: number; page: number; limit: number; totalPages: number }
}

export const fail = (code: string, message: string, status: HttpStatus) =>
  new RequestException({ code, message }, status)

/**
 * The brand token wallet (`internal`/`TKN`) and its balance per origin. Every movement locks the
 * wallet row, moves `balance` and the origin buckets by the same amount, and is idempotent by key.
 */
@Injectable()
export class TokenWalletService {
  private readonly logger = new Logger(TokenWalletService.name)

  constructor(
    @InjectRepository(Wallet, 'DBWrite')
    private readonly walletRepository: Repository<Wallet>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
  ) {}

  /** Returns the brand token wallet, creating it once; concurrent calls get the same row. */
  async getOrCreate(brandId: string, userId: string): Promise<TokenWalletView> {
    const key = { brandId, provider: WalletProvider.INTERNAL as string, currency: TOKEN_CURRENCY }
    // Relies on the unique (brandId, provider, currency) index: the loser of a race inserts nothing.
    await this.walletRepository
      .createQueryBuilder()
      .insert()
      .into(Wallet)
      .values({ ...key, userId, balance: 0, status: WalletStatus.ACTIVE })
      .orIgnore()
      .execute()
    // Read on the write connection: the replica may not have the row yet.
    const wallet = await this.walletRepository.findOne({ where: key })
    return toView(wallet!)
  }

  /**
   * Credits `amount` tokens from `origin`. Frozen wallets take credits; closed ones do not. `audit`
   * commits with the credit; a replay does not run it again.
   */
  async creditTokens(
    walletId: string,
    amount: number,
    origin: TokenOrigin,
    data: Partial<Transaction> & { brandId: string },
    idempotencyKey?: string,
    audit?: MovementAudit,
  ): Promise<TokenMovement> {
    const { expected, apply } = planCredit(walletId, amount, origin)
    return this.move(walletId, data, idempotencyKey, expected, audit, undefined, apply)
  }

  /**
   * Debits `amount` gift tokens only. Frozen wallets take gift debits; closed ones do not.
   * Refuses with 400 INSUFFICIENT_GIFT_TOKENS when `giftTokens` or `balance` does not cover it.
   */
  async debitGiftTokens(
    walletId: string,
    amount: number,
    data: Partial<Transaction> & { brandId: string },
    idempotencyKey?: string,
    audit?: MovementAudit,
  ): Promise<TokenMovement> {
    const cents = assertAmount(amount)
    const expected: ExpectedMovement = {
      walletId,
      type: TransactionType.DEBIT,
      cents,
      origin: TokenOrigin.GIFT,
    }
    return this.move(walletId, data, idempotencyKey, expected, audit, undefined, (wallet) => {
      if (wallet.status === WalletStatus.CLOSED) {
        throw fail('WALLET_CLOSED', 'Wallet is closed', HttpStatus.UNPROCESSABLE_ENTITY)
      }
      const giftCents = toCents(wallet.giftTokens)
      if (cents > giftCents || cents > toCents(wallet.balance)) {
        throw fail('INSUFFICIENT_GIFT_TOKENS', 'Insufficient gift tokens', HttpStatus.BAD_REQUEST)
      }
      wallet.giftTokens = fromCents(giftCents - cents)
      return { type: TransactionType.DEBIT, tokenOrigin: TokenOrigin.GIFT, delta: -cents }
    })
  }

  /**
   * The credit of `creditTokens`, inside the caller's transaction through its `manager`: it commits
   * or rolls back with it. A key already used by another movement aborts that transaction.
   */
  async creditTokensIn(
    manager: EntityManager,
    walletId: string,
    amount: number,
    origin: TokenOrigin,
    data: Partial<Transaction> & { brandId: string },
    idempotencyKey: string,
    audit?: MovementAudit,
  ): Promise<TokenMovement> {
    const { expected, apply } = planCredit(walletId, amount, origin)
    return this.moveIn(manager, walletId, data, idempotencyKey, expected, audit, apply)
  }

  /**
   * Debits `amount` tokens: gift first, then purchased; Dropi tokens only when `inDropi` is true.
   * Refuses when those origins, or the wallet balance, do not cover it.
   */
  async debitTokens(
    walletId: string,
    amount: number,
    context: { brandId: string; inDropi?: boolean },
    data: Partial<Transaction> = {},
    idempotencyKey?: string,
    limits?: MovementLimits,
  ): Promise<TokenMovement> {
    const cents = assertAmount(amount)
    const expected = { walletId, type: TransactionType.DEBIT, cents, origin: null }
    const txData = { ...data, brandId: context.brandId }
    return this.move(walletId, txData, idempotencyKey, expected, undefined, limits, (wallet) => {
      if (wallet.status !== WalletStatus.ACTIVE) {
        throw fail(
          'WALLET_NOT_ACTIVE',
          'Wallet is frozen or closed',
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      const split = planTokenSpend(bucketsOf(wallet), cents, context.inDropi === true)
      if (!split || cents > toCents(wallet.balance)) {
        throw fail('INSUFFICIENT_BALANCE', 'Insufficient tokens', HttpStatus.UNPROCESSABLE_ENTITY)
      }
      wallet.giftTokens = fromCents(toCents(wallet.giftTokens) - split.gift)
      wallet.purchasedTokens = fromCents(toCents(wallet.purchasedTokens) - split.purchased)
      wallet.dropiTokens = fromCents(toCents(wallet.dropiTokens) - split.dropi)
      const tokenSplit = {
        gift: fromCents(split.gift),
        purchased: fromCents(split.purchased),
        dropi: fromCents(split.dropi),
      }
      const metadata = { ...data.metadata, tokenSplit }
      return { type: TransactionType.DEBIT, tokenOrigin: null, delta: -cents, metadata }
    })
  }

  /**
   * Gives back `amount` tokens of the debit recorded under `debitKey`, in the reverse order of the
   * spend and never past what that debit took from each origin minus its earlier refunds. 404 when
   * the wallet has no such debit, 422 past the debit. Frozen wallets take it; closed ones do not.
   */
  async refundDebit(
    walletId: string,
    amount: number,
    context: { brandId: string; debitKey: string },
    data: Partial<Transaction> = {},
    refundKey?: string,
  ): Promise<TokenMovement> {
    const cents = assertAmount(amount)
    const expected = { walletId, type: TransactionType.CREDIT, cents, origin: null }
    const txData = { ...data, brandId: context.brandId, referenceType: DEBIT_REFUND_REFERENCE }
    return this.move(
      walletId,
      txData,
      refundKey,
      expected,
      undefined,
      undefined,
      async (wallet, manager) => {
        if (wallet.status === WalletStatus.CLOSED) {
          throw fail('WALLET_CLOSED', 'Wallet is closed', HttpStatus.UNPROCESSABLE_ENTITY)
        }
        const debit = await manager.findOne(Transaction, {
          where: { idempotencyKey: context.debitKey },
        })
        if (!debit || debit.type !== TransactionType.DEBIT || debit.walletId !== wallet.id) {
          throw fail(
            'DEBIT_NOT_FOUND',
            'No debit with this key on the wallet',
            HttpStatus.NOT_FOUND,
          )
        }
        const earlier = await manager.find(Transaction, {
          where: { referenceType: DEBIT_REFUND_REFERENCE, referenceId: debit.id },
        })
        const owed = owedByDebit(
          debit.metadata?.tokenSplit,
          earlier.map((refund) => refund.metadata?.tokenSplit),
        )
        const split = planTokenRefund(owed, cents)
        if (!split) {
          throw fail(
            'REFUND_EXCEEDS_DEBIT',
            'Refund exceeds the debit',
            HttpStatus.UNPROCESSABLE_ENTITY,
          )
        }
        wallet.giftTokens = fromCents(toCents(wallet.giftTokens) + split.gift)
        wallet.purchasedTokens = fromCents(toCents(wallet.purchasedTokens) + split.purchased)
        wallet.dropiTokens = fromCents(toCents(wallet.dropiTokens) + split.dropi)
        const tokenSplit = {
          gift: fromCents(split.gift),
          purchased: fromCents(split.purchased),
          dropi: fromCents(split.dropi),
        }
        const metadata = { ...data.metadata, tokenSplit, debitId: debit.id }
        return {
          type: TransactionType.CREDIT,
          tokenOrigin: null,
          delta: cents,
          metadata,
          referenceId: debit.id,
        }
      },
    )
  }

  /** Id of the brand token wallet, or `null` when the brand has none; never creates it. */
  async findTokenWalletId(brandId: string): Promise<string | null> {
    const wallet = await this.walletRepository.findOne({
      where: { brandId, provider: WalletProvider.INTERNAL as string, currency: TOKEN_CURRENCY },
    })
    return wallet?.id ?? null
  }

  /**
   * Lists the brand token wallet movements from newest to oldest, without creating a wallet when the
   * brand has none, and projecting only the brand-visible fields (never description, metadata or author).
   */
  async listMovements(
    brandId: string,
    filters: {
      page?: number
      limit?: number
      type?: TransactionType
      dateFrom?: string
      dateTo?: string
    } = {},
  ): Promise<TokenWalletMovementsPage> {
    const page = filters.page || 1
    const limit = filters.limit || 20
    const walletId = await this.findTokenWalletId(brandId)
    if (!walletId) {
      return { data: [], meta: { total: 0, page, limit, totalPages: 0 } }
    }
    const qb = this.dataSource
      .getRepository(Transaction)
      .createQueryBuilder('t')
      .where('t.walletId = :walletId', { walletId })
    if (filters.type) {
      qb.andWhere('t.type = :type', { type: filters.type })
    }
    if (filters.dateFrom) {
      qb.andWhere('t.createdAt >= :dateFrom', { dateFrom: new Date(filters.dateFrom) })
    }
    if (filters.dateTo) {
      qb.andWhere('t.createdAt <= :dateTo', { dateTo: new Date(filters.dateTo) })
    }
    const [rows, total] = await qb
      .orderBy('t.createdAt', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount()
    return {
      data: rows.map(toMovementView),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    }
  }

  private async move(
    walletId: string,
    data: Partial<Transaction> & { brandId: string },
    idempotencyKey: string | undefined,
    expected: ExpectedMovement,
    audit: MovementAudit | undefined,
    limits: MovementLimits | undefined,
    apply: (wallet: Wallet, manager: EntityManager) => AppliedMovement | Promise<AppliedMovement>,
  ): Promise<TokenMovement> {
    const key = idempotencyKey ?? data.idempotencyKey
    const queryRunner = this.dataSource.createQueryRunner()
    if (limits) {
      await connectWithin(queryRunner, limits.connectTimeoutMs).catch((error) => {
        throw isLimitHit(error) ? walletBusy() : error
      })
    } else {
      await queryRunner.connect()
    }
    await queryRunner.startTransaction()
    try {
      if (limits) await applyLimits(queryRunner, limits)
      const movement = await this.moveIn(
        queryRunner.manager,
        walletId,
        data,
        key,
        expected,
        audit,
        apply,
      )
      if (movement.replayed) {
        await queryRunner.rollbackTransaction()
        return movement
      }
      await queryRunner.commitTransaction()
      this.logger.log(
        `Token ${movement.transaction.type} of ${expected.cents / 100} on wallet ${walletId}`,
      )
      return movement
    } catch (error) {
      const limitHit = limits !== undefined && isLimitHit(error)
      if (queryRunner.isTransactionActive) {
        try {
          await queryRunner.rollbackTransaction()
        } catch (rollbackError) {
          // transaction_timeout ends the session: the server already rolled back.
          if (!limitHit) throw rollbackError
        }
      }
      if (key && isUniqueConstraintViolation(error)) {
        // Awaited here: `finally` releases the query runner this lookup uses.
        return await this.replayAfterConflict(queryRunner, walletId, key, expected)
      }
      if (limitHit) throw walletBusy()
      throw error
    } finally {
      await queryRunner.release()
    }
  }

  /** Locks the wallet, replays a used key, applies the movement and writes it with its audit. */
  private async moveIn(
    manager: EntityManager,
    walletId: string,
    data: Partial<Transaction> & { brandId: string },
    key: string | undefined,
    expected: ExpectedMovement,
    audit: MovementAudit | undefined,
    apply: (wallet: Wallet, manager: EntityManager) => AppliedMovement | Promise<AppliedMovement>,
  ): Promise<TokenMovement> {
    const wallet = await manager.findOne(Wallet, {
      where: { id: walletId },
      lock: { mode: 'pessimistic_write' },
    })
    if (!wallet || !data.brandId || wallet.brandId !== data.brandId) {
      throw fail('WALLET_NOT_FOUND', 'Wallet not found for this brand', HttpStatus.NOT_FOUND)
    }
    if (!isTokenCurrency(wallet.currency)) {
      throw fail('WALLET_CURRENCY_MISMATCH', 'Not a token wallet', HttpStatus.UNPROCESSABLE_ENTITY)
    }
    if (key) {
      const replay = await findReplay(manager, key, expected)
      if (replay) return { wallet: toView(wallet), transaction: replay, replayed: true }
    }

    const balanceBefore = toCents(wallet.balance)
    const applied = await apply(wallet, manager)
    wallet.balance = fromCents(balanceBefore + applied.delta)
    await manager.save(Wallet, wallet)
    const transaction = await manager.save(
      Transaction,
      manager.create(Transaction, {
        ...data,
        walletId,
        brandId: wallet.brandId,
        type: applied.type,
        amount: fromCents(Math.abs(applied.delta)),
        balanceBefore: fromCents(balanceBefore),
        balanceAfter: wallet.balance,
        status: TransactionStatus.COMPLETED,
        tokenOrigin: applied.tokenOrigin,
        metadata: applied.metadata ?? data.metadata,
        referenceId: applied.referenceId ?? data.referenceId,
        idempotencyKey: key,
      }),
    )
    if (audit) await audit(manager, transaction)
    return { wallet: toView(wallet), transaction, replayed: false }
  }

  private async replayAfterConflict(
    queryRunner: QueryRunner,
    walletId: string,
    key: string,
    expected: ExpectedMovement,
  ): Promise<TokenMovement> {
    const replay = await findReplay(queryRunner.manager, key, expected)
    if (!replay) {
      throw fail('IDEMPOTENCY_KEY_CONFLICT', 'Key already used', HttpStatus.CONFLICT)
    }
    const wallet = await queryRunner.manager.findOne(Wallet, { where: { id: walletId } })
    return { wallet: toView(wallet!), transaction: replay, replayed: true }
  }
}

interface ExpectedMovement {
  walletId: string
  type: TransactionType
  cents: number
  origin: TokenOrigin | null
}

interface AppliedMovement {
  type: TransactionType
  tokenOrigin: TokenOrigin | null
  delta: number
  metadata?: Record<string, unknown>
  referenceId?: string
}

/** `referenceType` of a refund; its `referenceId` is the refunded debit. */
export const DEBIT_REFUND_REFERENCE = 'token_debit_refund'

/**
 * The movement already recorded under `key` when it is this same movement, `null` when the key is
 * unused, and a 409 when the key belongs to another wallet, type, amount or origin.
 */
async function findReplay(manager: EntityManager, key: string, expected: ExpectedMovement) {
  const existing = await manager.findOne(Transaction, { where: { idempotencyKey: key } })
  if (!existing) return null
  const same =
    existing.walletId === expected.walletId &&
    existing.type === expected.type &&
    toCents(existing.amount) === expected.cents &&
    (existing.tokenOrigin ?? null) === expected.origin
  if (!same) {
    throw fail('IDEMPOTENCY_KEY_CONFLICT', 'Key already used', HttpStatus.CONFLICT)
  }
  return existing
}

/** The checked credit of `amount` tokens from `origin`: what a replay must match, and its effect. */
function planCredit(walletId: string, amount: number, origin: TokenOrigin) {
  const cents = assertAmount(amount)
  if (!Object.values(TokenOrigin).includes(origin)) {
    throw fail('INVALID_TOKEN_ORIGIN', 'Unknown token origin', HttpStatus.BAD_REQUEST)
  }
  const expected: ExpectedMovement = { walletId, type: TransactionType.CREDIT, cents, origin }
  const apply = (wallet: Wallet): AppliedMovement => {
    if (wallet.status === WalletStatus.CLOSED) {
      throw fail('WALLET_CLOSED', 'Wallet is closed', HttpStatus.UNPROCESSABLE_ENTITY)
    }
    const column = BUCKET_COLUMN[origin]
    wallet[column] = fromCents(toCents(wallet[column]) + cents)
    return { type: TransactionType.CREDIT, tokenOrigin: origin, delta: cents }
  }
  return { expected, apply }
}

function assertAmount(amount: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || toCents(amount) <= 0) {
    throw fail('INVALID_AMOUNT', 'Amount must be a positive finite number', HttpStatus.BAD_REQUEST)
  }
  return toCents(amount)
}

function bucketsOf(wallet: Wallet): TokenBuckets {
  return {
    gift: toCents(wallet.giftTokens),
    purchased: toCents(wallet.purchasedTokens),
    dropi: toCents(wallet.dropiTokens),
  }
}

function toView(wallet: Wallet): TokenWalletView {
  const buckets = bucketsOf(wallet)
  const balance = toCents(wallet.balance)
  return {
    id: wallet.id,
    brandId: wallet.brandId,
    status: wallet.status,
    currency: wallet.currency,
    balance: fromCents(balance),
    byOrigin: {
      gift: fromCents(buckets.gift),
      purchased: fromCents(buckets.purchased),
      dropi: fromCents(buckets.dropi),
    },
    unassigned: fromCents(balance - buckets.gift - buckets.purchased - buckets.dropi),
  }
}

function toMovementView(tx: Transaction): TokenWalletMovementView {
  const split = tx.metadata?.tokenSplit
  const tokenSplit =
    split && typeof split === 'object'
      ? {
          gift: Number(split.gift ?? 0),
          purchased: Number(split.purchased ?? 0),
          dropi: Number(split.dropi ?? 0),
        }
      : null
  return {
    id: tx.id,
    createdAt: tx.createdAt,
    type: tx.type,
    origin: tx.tokenOrigin ?? null,
    tokenSplit,
    amount: Number(tx.amount),
    balanceAfter: Number(tx.balanceAfter),
  }
}
