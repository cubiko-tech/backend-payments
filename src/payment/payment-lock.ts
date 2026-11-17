/** Anything able to run SQL inside the transaction that does the locked work. */
export interface LockRunner {
  query: (sql: string, params?: unknown[]) => Promise<unknown>
}

/**
 * Takes the per-payment advisory lock shared by the wallet debit, the reconciliation
 * sweep and the cancellation. It is held until `runner`'s transaction ends, so it
 * must be taken by the transaction doing the work, and before any wallet row lock.
 */
export async function lockPayment(runner: LockRunner, paymentId: string): Promise<void> {
  await runner.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `wallet-reconcile:${paymentId}`,
  ])
}
