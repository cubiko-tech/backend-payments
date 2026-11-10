/**
 * R6: Kept in one service (>400 lines) because preview, atomic INSERT...SELECT snapshot creation,
 * chunked BullMQ execution, crash reconciliation, and paginated reporting share one batch lifecycle.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectQueue } from '@nestjs/bullmq'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { Queue } from 'bullmq'
import { DataSource, Repository } from 'typeorm'
import { AuditService } from '../audit/audit.service'
import {
  CreateGiftBatchDto,
  GetGiftBatchQueryDto,
  GiftBatchFilterDto,
  PreviewGiftBatchDto,
} from '../admin/dto/admin-token-gift-batch.dto'
import { isUniqueConstraintViolation } from '../checkout/checkout-idempotency'
import { RequestException } from '../shared/exception/request.exception'
import { GiftBatchStatus, TokenGiftBatch } from './entities/token-gift-batch.entity'
import {
  GiftBatchItemOutcome,
  GiftBatchOmitReason,
  TokenGiftBatchItem,
} from './entities/token-gift-batch-item.entity'
import { WalletProvider, WalletStatus } from './entities/wallet.entity'
import { giftBatchBrandKey, tokenGiftLimits } from './token-gift-limits'
import { recordTokenGiftNotice } from './token-gift-notice'
import { TOKEN_CURRENCY, TokenOrigin } from './token-origin'
import { fromCents, toCents } from './token-spend'
import { fail, TokenWalletService } from './token-wallet.service'

export const TOKEN_GIFT_BATCH_QUEUE = 'token-gift-batch'
const ITEM_CONCURRENCY = 8

export interface GiftBatchPreviewView {
  brandCount: number
  amount: number
  totalTokens: number
}

export interface GiftBatchOmittedItemView {
  brandId: string
  walletId: string | null
  reason: GiftBatchOmitReason
}

export interface GiftBatchReportView {
  id: string
  status: GiftBatchStatus
  filter: { kind: 'all_open' | 'brands'; brandIds?: string[] }
  amount: number
  confirmedTotalTokens: number
  reason: string
  authorId: string
  totalBrands: number
  acreditada: number
  repetida: number
  omitida: number
  counts: {
    acreditada: number
    repetida: number
    omitida: number
    pending: number
  }
  totalCreditedTokens: number
  omitted: {
    data: GiftBatchOmittedItemView[]
    meta: { total: number; page: number; limit: number; totalPages: number }
  }
  createdAt: Date
  updatedAt: Date
  finishedAt: Date | null
}

@Injectable()
export class TokenGiftBatchService {
  private readonly logger = new Logger(TokenGiftBatchService.name)

  constructor(
    @InjectRepository(TokenGiftBatch, 'DBWrite')
    private readonly batchRepo: Repository<TokenGiftBatch>,
    @InjectRepository(TokenGiftBatchItem, 'DBWrite')
    private readonly itemRepo: Repository<TokenGiftBatchItem>,
    @InjectDataSource('DBWrite')
    private readonly dataSource: DataSource,
    @InjectQueue(TOKEN_GIFT_BATCH_QUEUE)
    private readonly queue: Queue,
    private readonly tokenWallets: TokenWalletService,
    private readonly auditService: AuditService,
  ) {}

  /** Counts matching brands in PostgreSQL without loading wallet rows into memory. */
  async preview(dto: PreviewGiftBatchDto): Promise<GiftBatchPreviewView> {
    const brandCount = await this.countForFilter(dto.filter)
    const totalTokens = fromCents(toCents(dto.amount) * brandCount)
    return { brandCount, amount: dto.amount, totalTokens }
  }

  /**
   * Recounts and snapshots the target brands with `INSERT … SELECT` inside one transaction. When
   * the count no longer matches `confirmedTotalTokens`, rolls back and answers 409 with the new
   * count and total so nothing is created or enqueued.
   */
  async create(dto: CreateGiftBatchDto, authorId: string): Promise<GiftBatchReportView> {
    const reason = dto.reason.trim()
    const brandIds = dto.filter.kind === 'brands' ? [...new Set(dto.filter.brandIds ?? [])] : null

    const existing = await this.batchRepo.findOne({
      where: { idempotencyKey: dto.idempotencyKey },
    })
    if (existing) {
      return this.replayExisting(existing, dto, reason, brandIds)
    }

    const queryRunner = this.dataSource.createQueryRunner()
    await queryRunner.connect()
    await queryRunner.startTransaction()
    let createdId: string
    try {
      const batch = await queryRunner.manager.save(
        TokenGiftBatch,
        queryRunner.manager.create(TokenGiftBatch, {
          idempotencyKey: dto.idempotencyKey,
          filterKind: dto.filter.kind,
          filterBrandIds: brandIds,
          amount: dto.amount,
          confirmedTotalTokens: dto.confirmedTotalTokens,
          reason,
          authorId,
          status: GiftBatchStatus.PENDING,
          totalBrands: 0,
        }),
      )
      const brandCount = await snapshotItems(queryRunner, batch.id, dto.filter.kind, brandIds)
      const actualTotalCents = brandCount * toCents(dto.amount)
      const actualTotalTokens = fromCents(actualTotalCents)
      if (brandCount === 0 || actualTotalCents !== toCents(dto.confirmedTotalTokens)) {
        await queryRunner.rollbackTransaction()
        throw new RequestException(
          {
            code: 'GIFT_BATCH_TOTAL_MISMATCH',
            message: 'The set of matching token wallets changed; confirm the new total',
            brandCount,
            amount: dto.amount,
            totalTokens: actualTotalTokens,
          },
          HttpStatus.CONFLICT,
        )
      }
      await queryRunner.manager.update(
        TokenGiftBatch,
        { id: batch.id },
        { totalBrands: brandCount },
      )
      await queryRunner.commitTransaction()
      createdId = batch.id
    } catch (error) {
      if (queryRunner.isTransactionActive) {
        await queryRunner.rollbackTransaction()
      }
      if (isUniqueConstraintViolation(error)) {
        const winner = await this.batchRepo.findOne({
          where: { idempotencyKey: dto.idempotencyKey },
        })
        if (winner) return await this.replayExisting(winner, dto, reason, brandIds)
      }
      throw error
    } finally {
      await queryRunner.release()
    }

    await this.enqueue(createdId)
    return this.getReport(createdId, {})
  }

  /**
   * Worker loop: processes `pending` snapshot items in chunks of `TOKEN_GIFT_BATCH_SIZE`. Resumable
   * after a crash because settled items are skipped and `giftBatchBrandKey` prevents double credits.
   */
  async executeBatch(batchId: string): Promise<void> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } })
    if (
      !batch ||
      batch.status === GiftBatchStatus.COMPLETED ||
      batch.status === GiftBatchStatus.FAILED
    ) {
      return
    }
    await this.batchRepo.update({ id: batchId }, { status: GiftBatchStatus.RUNNING })
    const { batchSize } = tokenGiftLimits()

    for (;;) {
      const pending = await this.itemRepo.find({
        where: { batchId, outcome: GiftBatchItemOutcome.PENDING },
        order: { seq: 'ASC' },
        take: batchSize,
      })
      if (pending.length === 0) break
      await runChunk(pending, ITEM_CONCURRENCY, (item) => this.processItem(batch, item))
    }

    await this.batchRepo.update(
      { id: batchId },
      { status: GiftBatchStatus.COMPLETED, finishedAt: new Date() },
    )
    this.logger.log(`Token gift batch ${batchId} completed`)
  }

  /** Marks the batch `failed` when BullMQ exhausts its attempts, keeping all settled items. */
  async markFailed(batchId: string): Promise<void> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } })
    if (!batch || batch.status === GiftBatchStatus.COMPLETED) return
    await this.reconcileCommittedItems(batchId)
    await this.batchRepo.update(
      { id: batchId },
      { status: GiftBatchStatus.FAILED, finishedAt: new Date() },
    )
  }

  async getReport(batchId: string, query: GetGiftBatchQueryDto = {}): Promise<GiftBatchReportView> {
    const batch = await this.batchRepo.findOne({ where: { id: batchId } })
    if (!batch) {
      throw fail('GIFT_BATCH_NOT_FOUND', 'Gift batch not found', HttpStatus.NOT_FOUND)
    }
    // Uses `||` instead of `??` because `transform: true` turns a missing query number into `NaN`.
    const page = Number(query.page) || 1
    const limit = Number(query.limit) || 20

    const aggRows = await this.dataSource.query(
      `SELECT
         "outcome",
         COUNT(*)::int AS "count",
         COALESCE(SUM("creditedAmount"), 0) AS "credited"
       FROM "token_gift_batch_items"
       WHERE "batchId" = $1
       GROUP BY "outcome"`,
      [batchId],
    )
    const counts = { acreditada: 0, repetida: 0, omitida: 0, pending: 0 }
    let totalCreditedCents = 0
    for (const row of aggRows as Array<{
      outcome: keyof typeof counts
      count: number
      credited: string
    }>) {
      if (row.outcome in counts) counts[row.outcome] = Number(row.count)
      if (row.outcome === GiftBatchItemOutcome.ACREDITADA) {
        totalCreditedCents += toCents(Number(row.credited))
      }
    }

    const [omittedRows, omittedTotal] = await this.itemRepo.findAndCount({
      where: { batchId, outcome: GiftBatchItemOutcome.OMITIDA },
      order: { seq: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    })

    const filter: GiftBatchReportView['filter'] =
      batch.filterKind === 'brands'
        ? { kind: 'brands', brandIds: batch.filterBrandIds ?? [] }
        : { kind: 'all_open' }

    return {
      id: batch.id,
      status: batch.status,
      filter,
      amount: Number(batch.amount),
      confirmedTotalTokens: Number(batch.confirmedTotalTokens),
      reason: batch.reason,
      authorId: batch.authorId,
      totalBrands: batch.totalBrands,
      acreditada: counts.acreditada,
      repetida: counts.repetida,
      omitida: counts.omitida,
      counts,
      totalCreditedTokens: fromCents(totalCreditedCents),
      omitted: {
        data: omittedRows.map((item) => ({
          brandId: item.brandId,
          walletId: item.walletId,
          reason: item.omitReason!,
        })),
        meta: {
          total: omittedTotal,
          page,
          limit,
          totalPages: omittedTotal === 0 ? 0 : Math.ceil(omittedTotal / limit),
        },
      },
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      finishedAt: batch.finishedAt,
    }
  }

  private async processItem(batch: TokenGiftBatch, item: TokenGiftBatchItem): Promise<void> {
    const walletId = item.walletId ?? (await this.tokenWallets.findTokenWalletId(item.brandId))
    if (!walletId) {
      await this.settleItem(item.id, {
        outcome: GiftBatchItemOutcome.OMITIDA,
        omitReason: GiftBatchOmitReason.SIN_WALLET,
      })
      return
    }

    const amount = Number(batch.amount)
    const key = giftBatchBrandKey(batch.id, item.brandId)
    try {
      const movement = await this.tokenWallets.creditTokens(
        walletId,
        amount,
        TokenOrigin.GIFT,
        {
          brandId: item.brandId,
          category: 'gift',
          description: batch.reason,
          referenceType: 'admin',
          referenceId: batch.authorId,
          metadata: { authorId: batch.authorId, reason: batch.reason, giftBatchId: batch.id },
        },
        key,
        async (manager, transaction) => {
          await this.auditService.record(manager, {
            userId: batch.authorId,
            action: 'token_gift',
            entityType: 'wallet',
            entityId: walletId,
            changes: {
              brandId: item.brandId,
              amount,
              reason: batch.reason,
              transactionId: transaction.id,
              giftBatchId: batch.id,
            },
            description: `Gift of ${amount} tokens: ${batch.reason}`,
          })
          await recordTokenGiftNotice(manager, {
            brandId: item.brandId,
            amount,
            balanceAfter: Number(transaction.balanceAfter),
            movementKey: transaction.idempotencyKey!,
          })
        },
      )
      const creditedByThisBatch =
        !movement.replayed || movement.transaction.metadata?.giftBatchId === batch.id
      await this.settleItem(item.id, {
        walletId,
        outcome: creditedByThisBatch
          ? GiftBatchItemOutcome.ACREDITADA
          : GiftBatchItemOutcome.REPETIDA,
        creditedAmount: creditedByThisBatch ? amount : 0,
        transactionId: movement.transaction.id,
      })
    } catch (error) {
      const code = error instanceof RequestException ? (error.getResponse() as any)?.code : null
      if (code === 'WALLET_NOT_FOUND') {
        await this.settleItem(item.id, {
          outcome: GiftBatchItemOutcome.OMITIDA,
          omitReason: GiftBatchOmitReason.SIN_WALLET,
        })
        return
      }
      if (code === 'WALLET_CLOSED') {
        await this.settleItem(item.id, {
          walletId,
          outcome: GiftBatchItemOutcome.OMITIDA,
          omitReason: GiftBatchOmitReason.CERRADA,
        })
        return
      }
      if (code === 'IDEMPOTENCY_KEY_CONFLICT') {
        await this.settleItem(item.id, { walletId, outcome: GiftBatchItemOutcome.REPETIDA })
        return
      }
      throw error
    }
  }

  private async settleItem(
    itemId: string,
    patch: {
      outcome: GiftBatchItemOutcome
      walletId?: string | null
      omitReason?: GiftBatchOmitReason | null
      creditedAmount?: number
      transactionId?: string | null
    },
  ): Promise<void> {
    await this.itemRepo.update(
      { id: itemId, outcome: GiftBatchItemOutcome.PENDING },
      {
        walletId: patch.walletId ?? null,
        outcome: patch.outcome,
        omitReason: patch.omitReason ?? null,
        creditedAmount: patch.creditedAmount ?? 0,
        transactionId: patch.transactionId ?? null,
      },
    )
  }

  /**
   * Reconciles any item that stayed `pending` because the final worker attempt crashed right after
   * `creditTokens` committed its `Transaction` and before `settleItem` updated the item row.
   */
  private async reconcileCommittedItems(batchId: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE "token_gift_batch_items" i
       SET
         "outcome" = CASE
           WHEN t."metadata"->>'giftBatchId' = $1::text THEN 'acreditada'
           ELSE 'repetida'
         END,
         "creditedAmount" = CASE
           WHEN t."metadata"->>'giftBatchId' = $1::text THEN t."amount"
           ELSE 0
         END,
         "transactionId" = t."id",
         "walletId" = COALESCE(i."walletId", t."walletId"),
         "updatedAt" = now()
       FROM "transactions" t
       WHERE i."batchId" = $1::uuid
         AND i."outcome" = 'pending'
         AND t."idempotencyKey" = ('gift-batch:' || $1::text || ':' || i."brandId")`,
      [batchId],
    )
  }

  private async replayExisting(
    existing: TokenGiftBatch,
    dto: CreateGiftBatchDto,
    reason: string,
    brandIds: string[] | null,
  ): Promise<GiftBatchReportView> {
    if (!sameBatchRequest(existing, dto, reason, brandIds)) {
      throw fail(
        'IDEMPOTENCY_KEY_CONFLICT',
        'Key already used for another gift batch',
        HttpStatus.CONFLICT,
      )
    }
    if (existing.status === GiftBatchStatus.PENDING) {
      await this.enqueue(existing.id)
    }
    return this.getReport(existing.id, {})
  }

  private async enqueue(batchId: string): Promise<void> {
    await this.queue.add(
      'process-gift-batch',
      { batchId },
      {
        jobId: batchId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    )
  }

  private async countForFilter(filter: GiftBatchFilterDto): Promise<number> {
    if (filter.kind === 'all_open') {
      const [row] = await this.dataSource.query(
        `SELECT COUNT(*)::int AS "count"
         FROM "wallets" w
         WHERE w."provider" = $1
           AND w."currency" = $2
           AND w."status" <> $3`,
        [WalletProvider.INTERNAL, TOKEN_CURRENCY, WalletStatus.CLOSED],
      )
      return Number(row?.count ?? 0)
    }
    const [row] = await this.dataSource.query(
      `SELECT COUNT(DISTINCT b.brand_id)::int AS "count"
       FROM unnest($1::text[]) AS b(brand_id)`,
      [filter.brandIds ?? []],
    )
    return Number(row?.count ?? 0)
  }
}

async function snapshotItems(
  queryRunner: { query: (sql: string, params?: unknown[]) => Promise<Array<{ count: number }>> },
  batchId: string,
  filterKind: 'all_open' | 'brands',
  brandIds: string[] | null,
): Promise<number> {
  if (filterKind === 'all_open') {
    const [row] = await queryRunner.query(
      `WITH inserted AS (
         INSERT INTO "token_gift_batch_items" ("batchId", "seq", "brandId", "walletId", "outcome", "omitReason")
         SELECT
           $1::uuid,
           ROW_NUMBER() OVER (ORDER BY w."createdAt" ASC, w."id" ASC)::int,
           w."brandId",
           w."id",
           'pending',
           NULL
         FROM "wallets" w
         WHERE w."provider" = $2
           AND w."currency" = $3
           AND w."status" <> $4
         RETURNING 1
       )
       SELECT COUNT(*)::int AS "count" FROM inserted`,
      [batchId, WalletProvider.INTERNAL, TOKEN_CURRENCY, WalletStatus.CLOSED],
    )
    return Number(row?.count ?? 0)
  }
  const [row] = await queryRunner.query(
    `WITH raw AS (
       SELECT u.brand_id, MIN(u.ord)::int AS ord
       FROM unnest($2::text[]) WITH ORDINALITY AS u(brand_id, ord)
       GROUP BY u.brand_id
     ),
     inserted AS (
       INSERT INTO "token_gift_batch_items" ("batchId", "seq", "brandId", "walletId", "outcome", "omitReason")
       SELECT
         $1::uuid,
         ROW_NUMBER() OVER (ORDER BY raw.ord ASC)::int,
         raw.brand_id,
         w."id",
         'pending',
         NULL
       FROM raw
       LEFT JOIN "wallets" w
         ON w."brandId" = raw.brand_id
        AND w."provider" = $3
        AND w."currency" = $4
       ORDER BY raw.ord ASC
       RETURNING 1
     )
     SELECT COUNT(*)::int AS "count" FROM inserted`,
    [batchId, brandIds ?? [], WalletProvider.INTERNAL, TOKEN_CURRENCY],
  )
  return Number(row?.count ?? 0)
}

function sameBatchRequest(
  existing: TokenGiftBatch,
  dto: CreateGiftBatchDto,
  reason: string,
  brandIds: string[] | null,
): boolean {
  if (existing.filterKind !== dto.filter.kind) return false
  if (toCents(existing.amount) !== toCents(dto.amount)) return false
  if (toCents(existing.confirmedTotalTokens) !== toCents(dto.confirmedTotalTokens)) return false
  if (existing.reason !== reason) return false
  if (dto.filter.kind === 'brands') {
    const stored = existing.filterBrandIds ?? []
    const incoming = brandIds ?? []
    if (stored.length !== incoming.length) return false
    return stored.every((id, idx) => id === incoming[idx])
  }
  return true
}

async function runChunk<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index++]
      await worker(current)
    }
  })
  await Promise.all(runners)
}
