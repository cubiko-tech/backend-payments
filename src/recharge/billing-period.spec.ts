import { closingPeriod } from './billing-period'

describe('closingPeriod (LOC-206)', () => {
  const NOVEMBER_FIRST_BOGOTA = new Date('2026-11-01T05:00:00Z')

  it('the close run on November 1st at 00:00 in Bogota closes October', () => {
    // R15: red when the period is the current month: it answers 2026-11.
    expect(closingPeriod(NOVEMBER_FIRST_BOGOTA)).toEqual({
      period: '2026-10',
      cutoff: NOVEMBER_FIRST_BOGOTA,
    })
  })

  it('a rerun on November 2nd closes the same October, with the same cutoff', () => {
    // R15: red when the period depends on the day: the 2nd closes another month.
    expect(closingPeriod(new Date('2026-11-02T15:00:00Z'))).toEqual({
      period: '2026-10',
      cutoff: NOVEMBER_FIRST_BOGOTA,
    })
  })

  it('October 31st at 23:59:59 in Bogota still closes September, though UTC is already November', () => {
    // R15: red when the month is read in UTC: it answers 2026-10.
    expect(closingPeriod(new Date('2026-11-01T04:59:59Z'))).toEqual({
      period: '2026-09',
      cutoff: new Date('2026-10-01T05:00:00Z'),
    })
  })

  it('the close of January closes December of the year before', () => {
    // R15: red when the year does not roll back: it answers 2027-00 or 2027-12.
    expect(closingPeriod(new Date('2027-01-01T05:00:00Z'))).toEqual({
      period: '2026-12',
      cutoff: new Date('2027-01-01T05:00:00Z'),
    })
  })
})
