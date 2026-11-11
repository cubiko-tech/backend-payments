import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm'

/** pg returns `decimal` as a string; the rate is read back as a number. */
const decimalAsNumber = { to: (value: number) => value, from: (value: string) => Number(value) }

/**
 * The TRM a week started with: the USD→COP rate in force on its Monday in Bogota, stored once per week.
 * It is the reference ROAX Ads shows when the day's TRM cannot be read; nothing is charged with it.
 */
@Entity('trm_weekly_rates')
export class TrmWeeklyRate {
  /** Monday of the week, `YYYY-MM-DD` in Bogota. */
  @PrimaryColumn({ type: 'date' })
  weekStart: string

  /** COP per 1 USD. */
  @Column({ type: 'decimal', precision: 12, scale: 2, transformer: decimalAsNumber })
  rate: number

  /** Day the source's rate is valid from (a weekend rate can start on the Saturday before). */
  @Column({ type: 'date' })
  rateDate: string

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date
}
