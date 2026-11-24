import { advanceMark, isOutOfOrder, readNoticeOrder } from './confio-watermark.util'

const NAME = 'stores/s/subscription-plans/p/subscriptions/one'
const CHARGE = 'subscription.billingStatusChanged'
const STATUS = 'subscription.subscriptionStatusChanged'
const T0 = 1768384800
const at = (seconds: number) => new Date(seconds * 1000)

function charge(cycle: number, timestamp = T0, properties = ['name', 'cycleNumber', 'status']) {
  return {
    event: CHARGE,
    data: { name: NAME, cycleNumber: cycle, status: 'SUCCEEDED' },
    timestamp,
    signature: { properties, checksum: 'C' },
  }
}

function statusChange(timestamp: number) {
  return {
    event: STATUS,
    data: { name: NAME, status: 'EXPIRED', updateTime: '2099-01-01T00:00:00Z' },
    timestamp,
    signature: { properties: ['name', 'status'], checksum: 'C' },
  }
}

const row = (mark: any, providerSubscriptionId: string | null = NAME): any => ({
  providerSubscriptionId,
  providerWatermark: mark,
})

describe('confio-watermark.util', () => {
  describe('readNoticeOrder', () => {
    it('reads the signed cycle and the envelope timestamp in seconds', () => {
      // R15: red if every timestamp is read as milliseconds: the instant falls in 1970.
      expect(readNoticeOrder(charge(4) as any)).toEqual({ event: CHARGE, cycle: 4, at: at(T0) })
    })

    it('reads a millisecond timestamp as the same instant', () => {
      // R15: red if every timestamp is read as seconds: the instant lands a thousand times later.
      expect(readNoticeOrder(charge(4, T0 * 1000) as any).at).toEqual(at(T0))
    })

    it('ignores a cycle that is not signed', () => {
      // R15: red if `cycleNumber` is read without checking `signature.properties`.
      expect(readNoticeOrder(charge(4, T0, ['name', 'status']) as any).cycle).toBeUndefined()
    })

    it('never reads updateTime', () => {
      // R15: red if the unsigned `updateTime` orders a status change.
      expect(readNoticeOrder(statusChange(T0) as any).at).toEqual(at(T0))
    })

    it.each([['abc'], [''], [null], [undefined]])('has no instant for the timestamp %p', (ts) => {
      // R15: red if `at` is built without checking it is a finite instant.
      expect(readNoticeOrder({ ...statusChange(T0), timestamp: ts } as any).at).toBeUndefined()
    })
  })

  describe('isOutOfOrder', () => {
    it('lets anything through without a mark', () => {
      // R15: red if a row without a mark holds the notice (the first notice after the deploy).
      expect(isOutOfOrder(row(null), readNoticeOrder(statusChange(T0 - 100) as any))).toBe(false)
    })

    it('holds a status change older than the applied charge', () => {
      // R15: red if the mark is not compared (scenario 1, the old terminal after a charge).
      const mark = { name: NAME, cycle: 4, at: at(T0).toISOString() }
      expect(isOutOfOrder(row(mark), readNoticeOrder(statusChange(T0 - 1) as any))).toBe(true)
    })

    it('lets a status change of the same instant through', () => {
      // R15: red if an equal timestamp counts as older (`>=` turned into `>`).
      const mark = { name: NAME, at: at(T0).toISOString() }
      expect(isOutOfOrder(row(mark), readNoticeOrder(statusChange(T0) as any))).toBe(false)
    })

    it('holds a charge of an earlier cycle signed before the mark', () => {
      // R15: red if the mark is not compared: the older charge goes through.
      const mark = { name: NAME, cycle: 4, at: at(T0).toISOString() }
      expect(isOutOfOrder(row(mark), readNoticeOrder(charge(3, T0 - 500) as any))).toBe(true)
    })

    it('does not let a re-split cycle hold the real charges signed after it', () => {
      // R15: red if a lower cycle alone holds a notice: a forged cycle 11 would block cycles 2 to 10.
      const forged = { name: NAME, cycle: 11, at: at(T0).toISOString() }
      expect(isOutOfOrder(row(forged), readNoticeOrder(charge(2, T0 + 3600) as any))).toBe(false)
    })

    it('lets a charge of a later cycle through even with an earlier timestamp', () => {
      // R15: red if a later signed cycle does not exempt an older timestamp.
      const mark = { name: NAME, cycle: 4, at: at(T0).toISOString() }
      expect(isOutOfOrder(row(mark), readNoticeOrder(charge(5, T0 - 500) as any))).toBe(false)
    })

    it('orders two charges of the same cycle by their timestamp', () => {
      // R15: red if the mark is not compared: the older attempt of the cycle goes through.
      const mark = { name: NAME, cycle: 4, at: at(T0).toISOString() }
      expect(isOutOfOrder(row(mark), readNoticeOrder(charge(4, T0 - 1) as any))).toBe(true)
      expect(isOutOfOrder(row(mark), readNoticeOrder(charge(4, T0 + 1) as any))).toBe(false)
    })

    it('does not let the mark of a former Confio subscription hold cycle 1 of the new one', () => {
      // R15: red if the mark is read without comparing its `name` (scenario 8, the reused row).
      const mark = {
        name: 'stores/s/subscription-plans/p/subscriptions/old',
        cycle: 9,
        at: at(T0 + 600).toISOString(),
      }
      expect(isOutOfOrder(row(mark), readNoticeOrder(charge(1, T0) as any))).toBe(false)
    })
  })

  describe('advanceMark', () => {
    it('only moves each field forward', () => {
      // R15: red if the mark takes the notice's values instead of the maximum.
      const mark = { name: NAME, cycle: 4, at: at(T0).toISOString() }

      expect(advanceMark(row(mark), readNoticeOrder(statusChange(T0 + 60) as any))).toEqual({
        name: NAME,
        cycle: 4,
        at: at(T0 + 60).toISOString(),
      })
      expect(advanceMark(row(mark), readNoticeOrder(charge(5, T0 - 60) as any))).toEqual({
        name: NAME,
        cycle: 5,
        at: at(T0).toISOString(),
      })
    })

    it('starts over for a new Confio subscription', () => {
      // R15: red if the mark of the former Confio subscription is carried over.
      const mark = { name: 'stores/s/subscription-plans/p/subscriptions/old', cycle: 9 }

      expect(advanceMark(row(mark), readNoticeOrder(charge(1, T0) as any))).toEqual({
        name: NAME,
        cycle: 1,
        at: at(T0).toISOString(),
      })
    })
  })
})
