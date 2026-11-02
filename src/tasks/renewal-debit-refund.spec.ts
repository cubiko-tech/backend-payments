import { SubscriptionStatus } from '../subscription/entities/subscription.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import {
  canStillExtend,
  CycleExtension,
  cycleDebitKey,
  refundRenewalDebit,
} from './renewal-debit-refund'

const DATE = new Date('2026-10-01T00:00:00.000Z')
const row = (overrides = {}) => ({
  id: 'sub-1',
  nextBillingDate: DATE,
  status: SubscriptionStatus.ACTIVE,
  ...overrides,
})
const KEY = 'subscription:sub-1:2026-10-01T00:00:00.000Z'

describe('canStillExtend', () => {
  it.each([SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE])(
    'is true on the same cycle for a live row in %s',
    (status) => {
      // Red if a pass status leaves the list: a cycle a pass can still extend is refunded.
      expect(canStillExtend({ idempotencyKey: KEY }, row({ status }))).toBe(true)
    },
  )

  it.each([SubscriptionStatus.CANCELLED, SubscriptionStatus.EXPIRED, SubscriptionStatus.PENDING])(
    'is false for a row in %s',
    (status) => {
      // Red if the status is not looked at: a closed row keeps the money for good.
      expect(canStillExtend({ idempotencyKey: KEY }, row({ status }))).toBe(false)
    },
  )

  it('is false once the date moved', () => {
    // Red if the key is not compared: a moved date keeps the old debit.
    const moved = row({ nextBillingDate: new Date('2026-11-01T00:00:00.000Z') })
    expect(canStillExtend({ idempotencyKey: KEY }, moved)).toBe(false)
  })

  it('is false with no date, even for a key built from an empty one', () => {
    // Red if the date is not required: `null` would match a key that says `null`.
    const undated = row({ nextBillingDate: null })
    expect(canStillExtend({ idempotencyKey: cycleDebitKey(undated) }, undated)).toBe(false)
  })
})

describe('refundRenewalDebit', () => {
  const debit = {
    id: 'tx-1',
    walletId: 'wallet-1',
    brandId: 'brand-1',
    amount: '19900.00',
    referenceId: 'sub-1',
    idempotencyKey: KEY,
  } as unknown as Transaction

  // R17: this checks what the function hands over; the real wallet is in the e2e.
  const deps = (credit: jest.Mock) => ({
    walletService: { credit },
    auditService: { log: jest.fn() },
    transactionRepo: { update: jest.fn() },
  })

  it('credits the amount of the debit to its wallet with a key of its own, and marks it', async () => {
    // Red if the credit loses the key: a retried sweep credits twice.
    const d = deps(jest.fn().mockResolvedValue({ data: {} }))

    expect(await refundRenewalDebit(debit, d as any)).toBe(true)

    expect(d.walletService.credit).toHaveBeenCalledWith(
      'wallet-1',
      19900,
      expect.objectContaining({ brandId: 'brand-1', idempotencyKey: `${KEY}:refund` }),
      undefined,
      expect.objectContaining({ userId: 'system' }),
    )
    expect(d.transactionRepo.update).toHaveBeenCalledWith(
      { id: 'tx-1' },
      { metadata: { cycleExtension: CycleExtension.REFUNDED } },
    )
  })

  it.each([
    ['returns an error', jest.fn().mockResolvedValue({ error: 'db down' })],
    ['throws', jest.fn().mockRejectedValue(new Error('wallet not found'))],
  ])('neither audits nor marks when the credit %s', async (_label, credit) => {
    // Red if the failure is not caught: the debit is marked with no money back.
    const d = deps(credit)

    expect(await refundRenewalDebit(debit, d as any)).toBe(false)

    expect(d.auditService.log).not.toHaveBeenCalled()
    expect(d.transactionRepo.update).not.toHaveBeenCalled()
  })
})
