import {
  claimFailedPaymentForRetry,
  closeWalletPayment,
  readPaymentAfterSweep,
} from './wallet-payment-close'

const ORIGINAL = 'Original failure'

// R17: A rollback that fails needs a dead connection, which a real base cannot do on demand.
function dataSourceWithFailingRollback(work: jest.Mock) {
  return {
    createQueryRunner: () => ({
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      isTransactionActive: true,
      rollbackTransaction: jest.fn().mockRejectedValue(new Error('Rollback failed')),
      release: jest.fn(),
      query: work,
      manager: { query: work, getRepository: () => ({ findOne: work }) },
    }),
  } as any
}

describe('wallet payment close, when the rollback also fails', () => {
  // R17: Forces the failure the rollback then runs on, the first query of each function.
  const failing = () => jest.fn().mockRejectedValue(new Error(ORIGINAL))

  it('closeWalletPayment surfaces the error that caused the rollback', async () => {
    // R15: red if the catch rolls back unprotected: the caller sees "Rollback failed".
    const payment = { brandId: 'brand', purpose: 'plan_purchase', purposeId: 'plan' } as any
    const deps = {
      dataSource: dataSourceWithFailingRollback(failing()),
      createOrRenewSubscription: jest.fn(),
    }

    await expect(closeWalletPayment(payment, {} as any, deps)).rejects.toThrow(ORIGINAL)
  })

  it('claimFailedPaymentForRetry surfaces the error that caused the rollback', async () => {
    // R15: red if the catch rolls back unprotected: the caller sees "Rollback failed".
    const dataSource = dataSourceWithFailingRollback(failing())

    await expect(claimFailedPaymentForRetry('id', {}, new Date(), dataSource)).rejects.toThrow(
      ORIGINAL,
    )
  })

  it('readPaymentAfterSweep surfaces the error that caused the rollback', async () => {
    // R15: red if the finally rolls back unprotected: the caller sees "Rollback failed".
    const dataSource = dataSourceWithFailingRollback(failing())

    await expect(readPaymentAfterSweep('id', dataSource)).rejects.toThrow(ORIGINAL)
  })
})
