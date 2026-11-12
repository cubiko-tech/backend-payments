/**
 * Runs `worker` over `items` with at most `concurrency` calls in flight.
 *
 * After the first failure no runner takes a new item; it waits for the calls already in flight and then
 * rejects with that first error, so the caller (a BullMQ attempt) never returns while work keeps going.
 */
export async function runChunk<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0
  let failed = false
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && index < items.length) {
      const current = items[index++]
      try {
        await worker(current)
      } catch (err) {
        failed = true
        throw err
      }
    }
  })
  const results = await Promise.allSettled(runners)
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (rejected) throw rejected.reason
}
