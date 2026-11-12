/**
 * The monthly close of automatic recharges from Dropi against PostgreSQL (LOC-206): one invoice per
 * brand and period, the Bogota cutoff, reruns and two instances at once. `closeMonth` runs only with
 * a November `now` (cutoff November 1st); a later month closes through `closeBrand` for this
 * suite's brand, because a December `closeMonth` would take other suites' recharges paid today.
 */
import { config as dotenvConfig } from 'dotenv'
import { DataSource } from 'typeorm'

import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { apmDouble, dianDouble } from './support/dropi-recharge.fixture'
import {
  BOGOTA,
  closeOn,
  completedRecharge,
  invoiceIdOf,
  invoicesOf,
  itemsReferencing,
  NOVEMBER_CUTOFF,
  OCTOBER_CUTOFF,
  refundGift,
  takeMonthlyInvoiceNumber,
} from './support/recharge-invoice.fixture'
import {
  cleanBrand,
  RaceInstance,
  someoneWaitsOnAdvisoryLock,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'a2060000-0000-4000-8000-0000000000c1'
const OTHER_BRAND = 'a2060000-0000-4000-8000-0000000000c2'

describe('The monthly close of automatic recharges from Dropi (PostgreSQL, LOC-206)', () => {
  let a: RaceInstance
  let b: RaceInstance

  const clean = async (dataSource: DataSource) => {
    for (const brandId of [BRAND, OTHER_BRAND]) {
      await dataSource.query(
        `DELETE FROM audit_log WHERE "entityType" = 'invoice'
         AND "entityId" IN (SELECT id::text FROM invoices WHERE "brandId" = $1)`,
        [brandId],
      )
      await cleanBrand(dataSource, brandId)
    }
  }
  const closeNovember = () => closeOn(a.dataSource).closeMonth(BOGOTA.nov1FirstSecond)
  const closeDecember = () => closeOn(a.dataSource).closeBrand(BRAND, '2026-11', NOVEMBER_CUTOFF)

  beforeAll(async () => {
    a = await startInstance()
    b = await startInstance()
  })

  beforeEach(() => clean(a.dataSource))

  afterAll(async () => {
    if (a) await clean(a.dataSource)
    await stopInstance(a)
    await stopInstance(b)
  })

  it('CA3: three October recharges of a brand go into one invoice and a refund gift does not', async () => {
    // R15: red when the close emits one invoice per recharge: the brand ends with three.
    const recharges = [
      await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15),
      await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15, 'automatic', {
        amount: 20000,
        subtotal: 16806.72,
        taxAmount: 3193.28,
      }),
      await completedRecharge(a.dataSource, BRAND, BOGOTA.oct31LastSecond),
    ]
    const gift = await refundGift(a.dataSource, BRAND)

    const closes = await closeNovember()

    const invoices = await invoicesOf(a.dataSource, BRAND)
    expect(invoices).toHaveLength(1)
    const [invoice] = invoices
    expect(closes.find((close) => close.brandId === BRAND)?.invoice?.id).toBe(invoice.id)
    expect(invoice.period).toBe('2026-10')
    expect(invoice.paymentId).toBeNull()
    expect(Number(invoice.total)).toBe(40000 + 20000 + 40000)
    expect(Number(invoice.subtotal)).toBe(84033.62)
    expect(Number(invoice.taxTotal)).toBe(15966.38)
    expect(invoice.items.map((item) => item.referenceId).sort()).toEqual(
      recharges.map((recharge) => recharge.id).sort(),
    )
    for (const recharge of recharges) {
      expect(await invoiceIdOf(a.dataSource, recharge.id)).toBe(invoice.id)
    }
    expect(await itemsReferencing(a.dataSource, gift.id)).toHaveLength(0)
    const audits = await a.dataSource
      .getRepository(AuditLog)
      .findBy({ entityType: 'invoice', entityId: invoice.id })
    expect(audits.map((row) => row.action)).toEqual(['recharge_invoice_closed'])
    expect(audits[0].changes).toMatchObject({ brandId: BRAND, period: '2026-10' })
  })

  it('CA3: the last second of October goes in, the first of November waits for December', async () => {
    // R15: red when the cutoff takes the first second of November: it lands in October's invoice.
    const last = await completedRecharge(a.dataSource, BRAND, BOGOTA.oct31LastSecond)
    const first = await completedRecharge(a.dataSource, BRAND, BOGOTA.nov1FirstSecond)

    await closeNovember()

    const [october] = await invoicesOf(a.dataSource, BRAND)
    expect(october.items.map((item) => item.referenceId)).toEqual([last.id])
    expect(await invoiceIdOf(a.dataSource, first.id)).toBeNull()

    const november = await closeDecember()
    expect(november?.period).toBe('2026-11')
    expect(await invoiceIdOf(a.dataSource, first.id)).toBe(november?.id)
    expect(await invoiceIdOf(a.dataSource, last.id)).toBe(october.id)
  })

  it('CA3: the window is half-open: paid at the cutoff instant waits, half a second before goes in', async () => {
    // R15: red when the cutoff is closed (`<= cutoff`): the one paid at 00:00:00.000 lands in October.
    const before = await completedRecharge(
      a.dataSource,
      BRAND,
      new Date('2026-11-01T04:59:59.500Z'),
    )
    const atCutoff = await completedRecharge(a.dataSource, BRAND, OCTOBER_CUTOFF)

    await closeNovember()

    const [october] = await invoicesOf(a.dataSource, BRAND)
    expect(october.items.map((item) => item.referenceId)).toEqual([before.id])
    expect(await invoiceIdOf(a.dataSource, before.id)).toBe(october.id)
    expect(await invoiceIdOf(a.dataSource, atCutoff.id)).toBeNull()
  })

  it('CA3: running the close twice emits no second invoice, even with a recharge left to claim', async () => {
    // R15: red when a unique violation stops reading the period's invoice: the second close throws.
    await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15)
    await closeNovember()
    const late = await completedRecharge(a.dataSource, BRAND, BOGOTA.oct31LastSecond)

    const again = await closeNovember()

    expect(again.find((close) => close.brandId === BRAND)).toEqual({ brandId: BRAND })
    const invoices = await invoicesOf(a.dataSource, BRAND)
    expect(invoices).toHaveLength(1)
    expect(invoices[0].items).toHaveLength(1)
    expect(await invoiceIdOf(a.dataSource, late.id)).toBeNull()
  })

  it('two instances closing the same month at once emit one invoice per brand', async () => {
    // R15: red only with the lock, the `invoiceId IS NULL` claim and the 23505 reread all gone: an error.
    // Each defense alone is held by another; the lock case and the migration's index case redden them.
    for (const brandId of [BRAND, OTHER_BRAND]) {
      await completedRecharge(a.dataSource, brandId, BOGOTA.oct15)
      await completedRecharge(a.dataSource, brandId, BOGOTA.oct31LastSecond)
    }

    const [fromA, fromB] = await Promise.all([
      closeOn(a.dataSource).closeMonth(BOGOTA.nov1FirstSecond),
      closeOn(b.dataSource).closeMonth(BOGOTA.nov1FirstSecond),
    ])

    for (const brandId of [BRAND, OTHER_BRAND]) {
      const invoices = await invoicesOf(a.dataSource, brandId)
      expect(invoices).toHaveLength(1)
      expect(invoices[0].items).toHaveLength(2)
    }
    expect([...fromA, ...fromB].filter((close) => close.error)).toEqual([])
  })

  it('a close waits while another holds the lock of the brand and period', async () => {
    // R15: red when the close drops its advisory lock: it invoices while the lock is held.
    const recharge = await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15)
    const holder = b.dataSource.createQueryRunner()
    await holder.connect()
    await holder.startTransaction()
    try {
      await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `recharge-invoice:${BRAND}:2026-10`,
      ])
      const closing = closeOn(a.dataSource).closeBrand(BRAND, '2026-10', OCTOBER_CUTOFF)

      expect(await someoneWaitsOnAdvisoryLock(a.dataSource)).toBe(true)
      expect(await invoicesOf(a.dataSource, BRAND)).toHaveLength(0)
      expect(await invoiceIdOf(a.dataSource, recharge.id)).toBeNull()

      await holder.commitTransaction()
      const invoice = await closing
      expect(await invoiceIdOf(a.dataSource, recharge.id)).toBe(invoice?.id)
    } finally {
      if (holder.isTransactionActive) await holder.rollbackTransaction()
      await holder.release()
    }
  })

  it('a recharge confirmed after October closed goes alone into the next close', async () => {
    // R15: red when the claim drops `invoiceId IS NULL`: November's invoice repeats October's three.
    const october = [
      await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15),
      await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15),
      await completedRecharge(a.dataSource, BRAND, BOGOTA.oct31LastSecond),
    ]
    await closeNovember()
    const [first] = await invoicesOf(a.dataSource, BRAND)
    const late = await completedRecharge(a.dataSource, BRAND, BOGOTA.oct31LastSecond)

    const next = await closeDecember()

    expect(next?.period).toBe('2026-11')
    const [, second] = await invoicesOf(a.dataSource, BRAND)
    expect(second.items.map((item) => item.referenceId)).toEqual([late.id])
    expect(await invoiceIdOf(a.dataSource, late.id)).toBe(second.id)
    for (const recharge of october) {
      expect(await invoiceIdOf(a.dataSource, recharge.id)).toBe(first.id)
    }
  })

  it('rerun on November 2nd closes October again: nothing new, November waits', async () => {
    // R15: red when the period is taken from the current month: the rerun invoices November's.
    await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15)
    await closeNovember()
    const november = await completedRecharge(a.dataSource, BRAND, BOGOTA.nov1FirstSecond)

    const rerun = await closeOn(a.dataSource).closeMonth(BOGOTA.nov2)

    expect(rerun.find((close) => close.brandId === BRAND)).toBeUndefined()
    const invoices = await invoicesOf(a.dataSource, BRAND)
    expect(invoices.map((invoice) => invoice.period)).toEqual(['2026-10'])
    expect(await invoiceIdOf(a.dataSource, november.id)).toBeNull()
  })

  it('CA3 (LOC-211): a brand whose close fails raises the alert; the other brand gets its invoice', async () => {
    // R15: red when the close's catch stops emitting the event: no RechargeInvoiceCloseFailed is recorded.
    const failing = await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15)
    const healthy = await completedRecharge(a.dataSource, OTHER_BRAND, BOGOTA.oct15)
    const taken = await takeMonthlyInvoiceNumber(a.dataSource, BRAND, '2026-10')
    const apm = apmDouble()

    const closes = await closeOn(a.dataSource, dianDouble(), apm).closeMonth(BOGOTA.nov1FirstSecond)

    expect(closes.find((close) => close.brandId === BRAND)?.error).toBeDefined()
    expect(apm.events).toContainEqual({
      type: 'RechargeInvoiceCloseFailed',
      attributes: { brandId: BRAND, period: '2026-10' },
    })
    expect(apm.events.filter((event) => event.attributes.brandId === OTHER_BRAND)).toEqual([])
    expect((await invoicesOf(a.dataSource, BRAND)).map((invoice) => invoice.id)).toEqual([taken.id])
    expect(await invoiceIdOf(a.dataSource, failing.id)).toBeNull()
    const [other] = await invoicesOf(a.dataSource, OTHER_BRAND)
    expect(other.period).toBe('2026-10')
    expect(await invoiceIdOf(a.dataSource, healthy.id)).toBe(other.id)
  })

  it('CA3 (LOC-211): a healthy close of two brands emits two invoices and no failure event', async () => {
    // R15: red when the close alerts every brand it closes, not only one that fails.
    for (const brandId of [BRAND, OTHER_BRAND]) {
      await completedRecharge(a.dataSource, brandId, BOGOTA.oct15)
    }
    const apm = apmDouble()

    await closeOn(a.dataSource, dianDouble(), apm).closeMonth(BOGOTA.nov1FirstSecond)

    for (const brandId of [BRAND, OTHER_BRAND]) {
      expect((await invoicesOf(a.dataSource, brandId)).map((invoice) => invoice.period)).toEqual([
        '2026-10',
      ])
    }
    const ours = apm.events.filter((event) =>
      [BRAND, OTHER_BRAND].includes(event.attributes.brandId as string),
    )
    expect(ours).toEqual([])
  })

  it('a manual recharge from before LOC-206, with no invoice, is not taken by the close', async () => {
    // R15: red when the close stops filtering `automatic`: the old manual one is invoiced monthly.
    const manual = await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15, 'legacy')
    const explicit = await completedRecharge(a.dataSource, BRAND, BOGOTA.oct15, 'manual')

    await closeNovember()

    expect(await invoicesOf(a.dataSource, BRAND)).toHaveLength(0)
    expect(await invoiceIdOf(a.dataSource, manual.id)).toBeNull()
    expect(await invoiceIdOf(a.dataSource, explicit.id)).toBeNull()
  })
})
