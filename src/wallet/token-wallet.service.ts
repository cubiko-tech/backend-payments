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
import { TokenBuckets, fromCents, planTokenSpend, toCents } from './token-spend'

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

const fail = (code: string, message: string, status: HttpStatus) =>
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

  /** Credits `amount` tokens from `origin`. Frozen wallets take credits; closed ones do not. */
  async creditTokens(
    walletId: string,
    amount: number,
    origin: TokenOrigin,
    data: Partial<Transaction> & { brandId: string },
    idempotencyKey?: string,
  ): Promise<TokenMovement> {
    const cents = assertAmount(amount)
    if (!Object.values(TokenOrigin).includes(origin)) {
      throw fail('INVALID_TOKEN_ORIGIN', 'Unknown token origin', HttpStatus.BAD_REQUEST)
    }
    const expected = { walletId, type: TransactionType.CREDIT, cents, origin }
    return this.move(walletId, data, idempotencyKey, expected, (wallet) => {
      if (wallet.status === WalletStatus.CLOSED) {
        throw fail('WALLET_CLOSED', 'Wallet is closed', HttpStatus.UNPROCESSABLE_ENTITY)
      }
      const column = BUCKET_COLUMN[origin]
      wallet[column] = fromCents(toCents(wallet[column]) + cents)
      return { type: TransactionType.CREDIT, tokenOrigin: origin, delta: cents }
    })
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
  ): Promise<TokenMovement> {
    const cents = assertAmount(amount)
    const expected = { walletId, type: TransactionType.DEBIT, cents, origin: null }
    const txData = { ...data, brandId: context.brandId }
    return this.move(walletId, txData, idempotencyKey, expected, (wallet) => {
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

  private async move(
    walletId: string,
    data: Partial<Transaction> & { brandId: string },
    idempotencyKey: string | undefined,
    expected: ExpectedMovement,
    apply: (wallet: Wallet) => AppliedMovement,
  ): Promise<TokenMovement> {
    const key = idempotencyKey ?? data.idempotencyKey
    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()
    try {
      const wallet = await queryRunner.manager.findOne(Wallet, {
        where: { id: walletId },
        lock: { mode: 'pessimistic_write' },
      })
      if (!wallet || !data.brandId || wallet.brandId !== data.brandId) {
        throw fail('WALLET_NOT_FOUND', 'Wallet not found for this brand', HttpStatus.NOT_FOUND)
      }
      if (!isTokenCurrency(wallet.currency)) {
        throw fail(
          'WALLET_CURRENCY_MISMATCH',
          'Not a token wallet',
          HttpStatus.UNPROCESSABLE_ENTITY,
        )
      }
      if (key) {
        const replay = await findReplay(queryRunner.manager, key, expected)
        if (replay) {
          await queryRunner.rollbackTransaction()
          return { wallet: toView(wallet), transaction: replay, replayed: true }
        }
      }

      const balanceBefore = toCents(wallet.balance)
      const applied = apply(wallet)
      wallet.balance = fromCents(balanceBefore + applied.delta)
      await queryRunner.manager.save(Wallet, wallet)
      const transaction = await queryRunner.manager.save(
        Transaction,
        queryRunner.manager.create(Transaction, {
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
          idempotencyKey: key,
        }),
      )
      await queryRunner.commitTransaction()
      this.logger.log(`Token ${applied.type} of ${expected.cents / 100} on wallet ${walletId}`)
      return { wallet: toView(wallet), transaction, replayed: false }
    } catch (error) {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction()
      if (key && isUniqueConstraintViolation(error)) {
        // Awaited here: `finally` releases the query runner this lookup uses.
        return await this.replayAfterConflict(queryRunner, walletId, key, expected)
      }
      throw error
    } finally {
      await queryRunner.release()
    }
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
}

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
