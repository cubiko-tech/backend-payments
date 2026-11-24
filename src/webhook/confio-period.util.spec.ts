import { aFecha, periodoDePrueba, periodoLocal, sumarUnCicloMensual } from './confio-period.util'

const NOW = new Date('2026-01-14T10:00:00Z')

describe('confio-period.util', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }))
  afterEach(() => jest.useRealTimers())

  describe('sumarUnCicloMensual', () => {
    it('clips January 31 to the last day of February', () => {
      // R15: red if the month is added without clipping (March 3).
      expect(sumarUnCicloMensual(new Date('2026-01-31T12:00:00Z'))).toEqual(
        new Date('2026-02-28T12:00:00Z'),
      )
    })

    it('keeps the day when the next month has it', () => {
      // R15: red if every month is clipped to the end of the previous one.
      expect(sumarUnCicloMensual(new Date('2026-01-15T12:00:00Z'))).toEqual(
        new Date('2026-02-15T12:00:00Z'),
      )
    })
  })

  describe('aFecha', () => {
    it.each([['not a date'], ['2026-13-45T00:00:00Z'], [new Date('nope')]])(
      'gives undefined for the invalid date %p',
      (value) => {
        // R15: red if an `Invalid Date` is returned as a usable date.
        expect(aFecha(value as any)).toBeUndefined()
      },
    )
  })

  describe('periodoLocal', () => {
    it('advances from the stored period end when it is still ahead', () => {
      // R15: red if the start is always floored at now: the stored end still ahead is skipped.
      const period = periodoLocal({ currentPeriodEnd: new Date('2026-01-31T00:00:00Z') } as any)

      expect(period.start).toEqual(new Date('2026-01-31T00:00:00Z'))
      expect(period.end).toEqual(new Date('2026-02-28T00:00:00Z'))
      expect(period.nextBilling).toEqual(period.end)
    })
  })

  describe('periodoDePrueba', () => {
    it('gives no period for an invalid trial end', () => {
      // R15: red if `aFecha` returns the `Invalid Date`: the trial gets a period that never ends.
      expect(periodoDePrueba({ trialEnd: 'garbage' } as any)).toBeUndefined()
    })
  })
})
