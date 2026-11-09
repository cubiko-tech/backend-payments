/** The zone the monthly recharge close counts its months in, the one of the TRM. */
export const BILLING_TIME_ZONE = 'America/Bogota'

export interface ClosingPeriod {
  /** `YYYY-MM` of the month being closed. */
  period: string
  /** First instant of the following month: recharges paid before it belong to the close. */
  cutoff: Date
}

const monthOf = new Intl.DateTimeFormat('en-CA', {
  timeZone: BILLING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
})

/** Offset of `instant` from UTC in Bogota, in ms (negative west of UTC). */
function offsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BILLING_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(instant)
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value)
  const wall = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  )
  return wall - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * The month a close run at `now` closes: the one before `now`'s month in Bogota, ending at the
 * 1st 00:00 there. It depends only on the month of `now`, so a rerun on the 2nd closes the same one.
 */
export function closingPeriod(now: Date): ClosingPeriod {
  const [year, month] = monthOf.format(now).split('-').map(Number)
  const firstUtcGuess = new Date(Date.UTC(year, month - 1, 1))
  const cutoff = new Date(firstUtcGuess.getTime() - offsetMs(firstUtcGuess))
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
  const period = `${previous.year}-${String(previous.month).padStart(2, '0')}`
  return { period, cutoff }
}
