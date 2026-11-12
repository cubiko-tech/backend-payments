import { runChunk } from './run-chunk'

describe('runChunk (LOC-253)', () => {
  it('takes no new item after a failure and rejects only once the calls in flight settle', async () => {
    const started: number[] = []
    let slowDone = false
    const worker = async (item: number) => {
      started.push(item)
      if (item === 0) throw new Error('brand 0 failed')
      if (item === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        slowDone = true
      }
    }

    // Mutation: keep Promise.all and drop the failed flag -> items 2..9 start and slowDone is false.
    await expect(runChunk([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 2, worker)).rejects.toThrow(
      'brand 0 failed',
    )
    expect(started.sort()).toEqual([0, 1])
    expect(slowDone).toBe(true)
  })

  it('runs every item with bounded concurrency when none fails', async () => {
    let inFlight = 0
    let peak = 0
    const done: number[] = []
    await runChunk([1, 2, 3, 4, 5], 2, async (item) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight--
      done.push(item)
    })
    expect(done.sort()).toEqual([1, 2, 3, 4, 5])
    expect(peak).toBe(2)
  })
})
