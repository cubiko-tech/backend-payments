import { HttpStatus } from '@nestjs/common'
import { Repository } from 'typeorm'

import { AdminController } from '../src/admin/admin.controller'
import { AuditService } from '../src/audit/audit.service'
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { WALLET_CLOSE_GIVEN_UP_FLAG } from '../src/checkout/wallet-payment-reconciliation'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { lockPayment } from '../src/payment/payment-lock'
import { Transaction, TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  backdate,
  cleanBrand,
  PLAN_PRICE,
  RaceInstance,
  seedWallet,
  sessionsWaitOnRowLock,
  someoneWaitsOnAdvisoryLock,
  startInstance,
  statusOf,
  stopInstance,
  sweepAfter,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7101076-2222-4333-8444-555555555555'

describe('Admin retry of a failed payment (PostgreSQL, LOC-176)', () => {
  let a: RaceInstance
  let b: RaceInstance
  let payments: Repository<Payment>
  let admin: AdminController
  let walletId: string

  const seedFailed = (over: Partial<Payment> = {}) =>
    payments.save(
      payments.create({
        brandId: BRAND_ID,
        userId: 'user-loc176',
        provider: PaymentProvider.WALLET,
        walletId,
        amount: PLAN_PRICE,
        currency: 'COP',
        status: PaymentStatus.FAILED,
        purpose: PaymentPurpose.PLAN_PURCHASE,
        purposeId: 'pro',
        ...over,
      }),
    )
  const movement = (paymentId: string, type: TransactionType, suffix: 'debit' | 'refund') => ({
    walletId,
    brandId: BRAND_ID,
    type,
    amount: PLAN_PRICE,
    balanceBefore: 0,
    balanceAfter: 0,
    referenceType: 'payment',
    referenceId: paymentId,
    idempotencyKey: `payment:${paymentId}:${suffix}`,
  })
  const seedMovement = (paymentId: string, type: TransactionType, suffix: 'debit' | 'refund') =>
    a.dataSource.getRepository(Transaction).save(movement(paymentId, type, suffix))
  const retryAudits = (paymentId: string) =>
    a.dataSource
      .getRepository(AuditLog)
      .countBy({ entityType: 'payment', entityId: paymentId, action: 'payment_retry' })
  const settle = (retry: Promise<unknown>) =>
    retry.then(
      () => null,
      (e) => e,
    )
  const expectConflict = async (retry: Promise<unknown>, code: string) => {
    const error = await settle(retry)
    expect(error).toMatchObject({ code })
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT)
  }
  /** Holds the payment lock on another instance, as a sweep crediting it would. */
  const holdPaymentLock = async (paymentId: string) => {
    const runner = b.dataSource.createQueryRunner()
    await runner.connect()
    await runner.startTransaction()
    await lockPayment(runner, paymentId)
    return runner
  }

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
    payments = a.dataSource.getRepository(Payment)
    const unused = null as never
    admin = new AdminController(
      unused,
      unused,
      unused,
      payments,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      a.moduleRef.get(AuditService),
      unused,
      unused,
    )
  })

  beforeEach(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    walletId = (await seedWallet(a.dataSource, BRAND_ID, 0)).id
  })

  afterAll(async () => {
    await cleanBrand(a.dataSource, BRAND_ID)
    await stopInstance(a)
    await stopInstance(b)
  })

  it('E1 refuses a failed payment whose money was credited back', async () => {
    // R15: red when the retry saves the payment without the claim: it ends up pending.
    const payment = await seedFailed()
    await seedMovement(payment.id, TransactionType.DEBIT, 'debit')
    await seedMovement(payment.id, TransactionType.CREDIT, 'refund')

    await expectConflict(admin.retryPayment(payment.id), 'PAYMENT_CREDITED_BACK')

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await retryAudits(payment.id)).toBe(0)
  })

  it('E2 moves a failed payment without a debit back to pending, keeping its createdAt', async () => {
    // R15: red when the retry hands the claim a new date as retriedAt: createdAt moves.
    const { id } = await seedFailed()
    await backdate(a.dataSource, id)
    const before = await payments.findOneByOrFail({ id })

    const result = await admin.retryPayment(id)

    expect(result).toEqual({ data: expect.objectContaining({ paymentId: id }) })
    const after = await payments.findOneByOrFail({ id })
    expect(after.status).toBe(PaymentStatus.PENDING)
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime())
    expect(await retryAudits(id)).toBe(1)
  })

  it('E2b the sweep fails again a retried wallet payment that never got its debit', async () => {
    // R15: red when the sweep leaves a wallet payment without a debit pending: it stays pending.
    const payment = await seedFailed()
    await admin.retryPayment(payment.id)

    await sweepAfter(a, payment.id, 60 * 60 * 1000)

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
  })

  it('E3 refuses a failed payment the close gave up on', async () => {
    // R15: red when the retry saves the payment without the claim: it ends up pending.
    const payment = await seedFailed({ metadata: { [WALLET_CLOSE_GIVEN_UP_FLAG]: true } })

    await expectConflict(admin.retryPayment(payment.id), 'PAYMENT_CREDITED_BACK')

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
  })

  it('E4 waits for a sweep crediting the payment and then refuses it', async () => {
    // R15: red without the payment lock in the claim: the retry does not wait and misses the credit.
    const payment = await seedFailed()
    await seedMovement(payment.id, TransactionType.DEBIT, 'debit')
    const sweep = await holdPaymentLock(payment.id)
    try {
      await sweep.manager
        .getRepository(Transaction)
        .save(movement(payment.id, TransactionType.CREDIT, 'refund'))
      const retrying = settle(admin.retryPayment(payment.id))
      const waited = await someoneWaitsOnAdvisoryLock(b.dataSource)
      await sweep.commitTransaction()

      expect(await retrying).toMatchObject({ code: 'PAYMENT_CREDITED_BACK' })
      expect(waited).toBe(true)
    } finally {
      if (sweep.isTransactionActive) await sweep.rollbackTransaction()
      await sweep.release()
    }

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
  })

  it('E5 two retries that both read failed claim the payment once', async () => {
    // R15: red when the retry ignores a claim that changed no row: two audits, two successes.
    const payment = await seedFailed()
    const held = await holdPaymentLock(payment.id)
    let results: PromiseSettledResult<unknown>[]
    try {
      const retries = Promise.allSettled([
        admin.retryPayment(payment.id),
        admin.retryPayment(payment.id),
      ])
      const bothWait = await sessionsWaitOnRowLock(b.dataSource, 2)
      await held.commitTransaction()
      results = await retries
      expect(bothWait).toBe(true)
    } finally {
      if (held.isTransactionActive) await held.rollbackTransaction()
      await held.release()
    }

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(refused.reason).toMatchObject({ code: 'PAYMENT_NOT_FAILED' })
    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.PENDING)
    expect(await retryAudits(payment.id)).toBe(1)
  })

  it('E6 refuses a failed recharge paid with the Dropi balance', async () => {
    // R15: red without the dropi_wallet refusal: the recharge ends up pending.
    const payment = await seedFailed({
      provider: PaymentProvider.DROPI_WALLET,
      purpose: PaymentPurpose.TOKEN_RECHARGE,
      walletId: undefined,
    })

    await expectConflict(admin.retryPayment(payment.id), 'PAYMENT_NOT_RETRYABLE')

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
  })

  it('E7 refuses a failed payment that still holds its debit, leaving it to the sweep', async () => {
    // R15: red when the claim ignores refuseDebited: the debited payment ends up pending.
    const payment = await seedFailed()
    await seedMovement(payment.id, TransactionType.DEBIT, 'debit')

    await expectConflict(admin.retryPayment(payment.id), 'PAYMENT_DEBITED')

    expect(await statusOf(a.dataSource, payment.id)).toBe(PaymentStatus.FAILED)
    expect(await retryAudits(payment.id)).toBe(0)
  })
})
