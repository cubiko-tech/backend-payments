import { getQueueToken } from '@nestjs/bullmq'
import { HttpStatus } from '@nestjs/common'
import { Test, TestingModule } from '@nestjs/testing'
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm'
import { Job } from 'bullmq'
import { AuditService } from '../audit/audit.service'
import { RequestException } from '../shared/exception/request.exception'
import { GiftBatchStatus, TokenGiftBatch } from './entities/token-gift-batch.entity'
import {
  GiftBatchItemOutcome,
  GiftBatchOmitReason,
  TokenGiftBatchItem,
} from './entities/token-gift-batch-item.entity'
import { TokenGiftNotice, TokenGiftNoticeStatus } from './entities/token-gift-notice.entity'
import { TokenGiftBatchProcessor } from './token-gift-batch.processor'
import { TOKEN_GIFT_BATCH_QUEUE, TokenGiftBatchService } from './token-gift-batch.service'
import { TokenWalletService } from './token-wallet.service'

const BATCH_ID = 'a2530000-0000-4000-8000-0000000000b1'
const BRAND_A = 'a2530000-0000-4000-8000-0000000000a1'
const WALLET_A = 'a2530000-0000-4000-8000-0000000000c1'

describe('TokenGiftBatchService & TokenGiftBatchProcessor (LOC-253)', () => {
  let service: TokenGiftBatchService
  let processor: TokenGiftBatchProcessor

  // R17: In-memory doubles isolate unit orchestration of batch state transitions and BullMQ retries without opening PostgreSQL.
  const batchRepo = {
    findOne: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
  }
  const itemRepo = {
    find: jest.fn(),
    findAndCount: jest.fn(),
    update: jest.fn().mockResolvedValue(undefined),
  }
  const queryRunner = {
    isTransactionActive: false,
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => {
      queryRunner.isTransactionActive = true
    }),
    commitTransaction: jest.fn(async () => {
      queryRunner.isTransactionActive = false
    }),
    rollbackTransaction: jest.fn(async () => {
      queryRunner.isTransactionActive = false
    }),
    release: jest.fn(async () => undefined),
    query: jest.fn(),
    manager: {
      create: jest.fn((_cls, data) => ({ id: BATCH_ID, ...data })),
      save: jest.fn(async (_cls, entity) => entity),
      update: jest.fn().mockResolvedValue(undefined),
    },
  }
  const dataSource = {
    query: jest.fn(),
    createQueryRunner: jest.fn(() => queryRunner),
  }
  const queue = { add: jest.fn().mockResolvedValue(undefined) }
  const tokenWallets = {
    findTokenWalletId: jest.fn(),
    creditTokens: jest.fn(),
  }
  const auditService = {
    record: jest.fn().mockResolvedValue(undefined),
  }

  beforeEach(async () => {
    jest.clearAllMocks()
    queryRunner.isTransactionActive = false

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TokenGiftBatchService,
        TokenGiftBatchProcessor,
        { provide: getRepositoryToken(TokenGiftBatch, 'DBWrite'), useValue: batchRepo },
        { provide: getRepositoryToken(TokenGiftBatchItem, 'DBWrite'), useValue: itemRepo },
        { provide: getDataSourceToken('DBWrite'), useValue: dataSource },
        { provide: getQueueToken(TOKEN_GIFT_BATCH_QUEUE), useValue: queue },
        { provide: TokenWalletService, useValue: tokenWallets },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile()

    service = moduleRef.get(TokenGiftBatchService)
    processor = moduleRef.get(TokenGiftBatchProcessor)
  })

  it('preview counts brands for all_open and brands filters and computes totalTokens', async () => {
    // R15: red if preview stops multiplying brandCount by amount.
    dataSource.query.mockResolvedValueOnce([{ count: 4 }])
    const allOpen = await service.preview({ filter: { kind: 'all_open' }, amount: 50 })
    expect(allOpen).toEqual({ brandCount: 4, amount: 50, totalTokens: 200 })

    dataSource.query.mockResolvedValueOnce([{ count: 2 }])
    const chosen = await service.preview({
      filter: { kind: 'brands', brandIds: [BRAND_A, BRAND_A] },
      amount: 12.5,
    })
    expect(chosen).toEqual({ brandCount: 2, amount: 12.5, totalTokens: 25 })
  })

  it('create rolls back and throws 409 GIFT_BATCH_TOTAL_MISMATCH when snapshot count mismatches confirmedTotalTokens', async () => {
    // R15: red if create commits without checking confirmedTotalTokens.
    batchRepo.findOne.mockResolvedValueOnce(null)
    queryRunner.query.mockResolvedValueOnce([{ count: 5 }])

    await expect(
      service.create(
        {
          filter: { kind: 'all_open' },
          amount: 50,
          confirmedTotalTokens: 200,
          reason: 'Bonus',
          idempotencyKey: 'k-mismatch',
        },
        'admin-1',
      ),
    ).rejects.toMatchObject({ status: HttpStatus.CONFLICT })

    expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1)
    expect(queryRunner.release).toHaveBeenCalledTimes(1)
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('create recovers from a concurrent unique constraint violation by replaying the winning batch', async () => {
    // R15: red if a 23505 race bubbles up as 500 instead of returning the winning batch.
    const existingBatch = {
      id: BATCH_ID,
      idempotencyKey: 'k-race',
      filterKind: 'brands' as const,
      filterBrandIds: [BRAND_A],
      amount: 50,
      confirmedTotalTokens: 50,
      reason: 'Bonus',
      authorId: 'admin-1',
      status: GiftBatchStatus.PENDING,
      totalBrands: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      finishedAt: null,
    }
    batchRepo.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingBatch)
      .mockResolvedValueOnce(existingBatch)
    queryRunner.manager.save.mockRejectedValueOnce({ code: '23505' })
    dataSource.query.mockResolvedValueOnce([])
    itemRepo.findAndCount.mockResolvedValueOnce([[], 0])

    const report = await service.create(
      {
        filter: { kind: 'brands', brandIds: [BRAND_A] },
        amount: 50,
        confirmedTotalTokens: 50,
        reason: 'Bonus',
        idempotencyKey: 'k-race',
      },
      'admin-1',
    )

    expect(report.id).toBe(BATCH_ID)
    expect(queue.add).toHaveBeenCalledWith(
      'process-gift-batch',
      { batchId: BATCH_ID },
      expect.objectContaining({ jobId: BATCH_ID }),
    )
    expect(queryRunner.release).toHaveBeenCalledTimes(1)
  })

  it('executeBatch handles closed, missing, and conflicting brand items and processor marks failed on final attempt', async () => {
    // R15: red if processor.onFailed marks failed before exhausting attempts or skips markFailed on the last attempt.
    batchRepo.findOne.mockResolvedValueOnce({
      id: BATCH_ID,
      status: GiftBatchStatus.PENDING,
      amount: 50,
      reason: 'Bonus',
      authorId: 'admin-1',
    })
    itemRepo.find
      .mockResolvedValueOnce([
        { id: 'i-1', batchId: BATCH_ID, seq: 1, brandId: 'b-no-wallet', walletId: null },
        { id: 'i-2', batchId: BATCH_ID, seq: 2, brandId: 'b-closed', walletId: WALLET_A },
        { id: 'i-3', batchId: BATCH_ID, seq: 3, brandId: 'b-conflict', walletId: WALLET_A },
      ])
      .mockResolvedValueOnce([])
    tokenWallets.findTokenWalletId.mockResolvedValueOnce(null)
    tokenWallets.creditTokens
      .mockRejectedValueOnce(
        new RequestException({ code: 'WALLET_CLOSED' }, HttpStatus.UNPROCESSABLE_ENTITY),
      )
      .mockRejectedValueOnce(
        new RequestException({ code: 'IDEMPOTENCY_KEY_CONFLICT' }, HttpStatus.CONFLICT),
      )

    await processor.process({
      data: { batchId: BATCH_ID },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as unknown as Job<{ batchId: string }>)

    expect(itemRepo.update).toHaveBeenCalledWith(
      { id: 'i-1', outcome: GiftBatchItemOutcome.PENDING },
      expect.objectContaining({
        outcome: GiftBatchItemOutcome.OMITIDA,
        omitReason: GiftBatchOmitReason.SIN_WALLET,
      }),
    )
    expect(itemRepo.update).toHaveBeenCalledWith(
      { id: 'i-2', outcome: GiftBatchItemOutcome.PENDING },
      expect.objectContaining({
        outcome: GiftBatchItemOutcome.OMITIDA,
        omitReason: GiftBatchOmitReason.CERRADA,
      }),
    )
    expect(itemRepo.update).toHaveBeenCalledWith(
      { id: 'i-3', outcome: GiftBatchItemOutcome.PENDING },
      expect.objectContaining({
        outcome: GiftBatchItemOutcome.REPETIDA,
      }),
    )

    batchRepo.update.mockClear()
    await processor.onFailed({
      data: { batchId: BATCH_ID },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as unknown as Job<{ batchId: string }>)
    expect(batchRepo.update).not.toHaveBeenCalled()

    batchRepo.findOne.mockResolvedValueOnce({
      id: BATCH_ID,
      status: GiftBatchStatus.RUNNING,
    })
    dataSource.query.mockResolvedValueOnce([])
    await processor.onFailed({
      data: { batchId: BATCH_ID },
      attemptsMade: 3,
      opts: { attempts: 3 },
    } as unknown as Job<{ batchId: string }>)
    expect(batchRepo.update).toHaveBeenCalledWith(
      { id: BATCH_ID },
      expect.objectContaining({ status: GiftBatchStatus.FAILED }),
    )
  })

  it('executeBatch writes a pending token_gift_notice without reason or author inside the credit audit callback', async () => {
    // R15: red if processItem skips recordTokenGiftNotice inside the creditTokens callback.
    batchRepo.findOne.mockResolvedValueOnce({
      id: BATCH_ID,
      status: GiftBatchStatus.PENDING,
      amount: 50,
      reason: 'Secret batch reason',
      authorId: 'admin-secret',
    })
    itemRepo.find
      .mockResolvedValueOnce([
        { id: 'i-ok', batchId: BATCH_ID, seq: 1, brandId: BRAND_A, walletId: WALLET_A },
      ])
      .mockResolvedValueOnce([])

    // R17: In-memory EntityManager passed to the creditTokens audit callback to inspect notice writes in unit scope.
    const itemManager = {
      // R17: Mirrors manager.create and manager.save inside the movement transaction without PostgreSQL.
      create: jest.fn((_cls, data) => data),
      save: jest.fn(async (_cls, entity) => entity),
    }
    tokenWallets.creditTokens.mockImplementationOnce(
      async (_walletId, _amount, _origin, _data, key, auditCb) => {
        const tx = {
          id: 'tx-1',
          balanceAfter: '125.00',
          idempotencyKey: key,
          metadata: { giftBatchId: BATCH_ID },
        }
        await auditCb(itemManager, tx)
        return { wallet: { id: WALLET_A }, transaction: tx, replayed: false }
      },
    )

    await service.executeBatch(BATCH_ID)

    expect(auditService.record).toHaveBeenCalledWith(
      itemManager,
      expect.objectContaining({
        userId: 'admin-secret',
        action: 'token_gift',
        entityId: WALLET_A,
      }),
    )
    expect(itemManager.save).toHaveBeenCalledWith(TokenGiftNotice, {
      brandId: BRAND_A,
      amount: 50,
      balanceAfter: 125,
      movementKey: `gift-batch:${BATCH_ID}:${BRAND_A}`,
      status: TokenGiftNoticeStatus.PENDIENTE,
    })
  })
})
