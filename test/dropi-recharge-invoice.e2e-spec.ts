/**
 * The invoice of a recharge from Dropi over HTTP against PostgreSQL (LOC-206): a manual one is
 * invoiced in the transaction that charges it, an automatic one waits for the monthly close, and
 * the `automatic` field is validated at the edge.
 */
import { HttpStatus } from '@nestjs/common'
import { config as dotenvConfig } from 'dotenv'

import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { Invoice } from '../src/invoice/entities/invoice.entity'
import { manualRechargeInvoiceNumber } from '../src/invoice/recharge-invoice'
import { Payment, PaymentStatus } from '../src/payment/entities/payment.entity'
import { AutomaticRechargeInvoiceService } from '../src/recharge/automatic-recharge-invoice.service'
import {
  ACCESS_SERVER,
  auditOf,
  cleanBillingProfile,
  creditsOf,
  forgetCachedTrm,
  JWT_SECRET,
  MEMBER_ID,
  postRecharge,
  postResult,
  rechargesOf,
  RechargeApp,
  startRechargeApp,
  tokenWalletOf,
} from './support/dropi-recharge.fixture'
import { invoicesOf } from './support/recharge-invoice.fixture'
import { startTrmSource, trmOk, TrmSource } from './support/trm-source.fixture'
import {
  cleanBrand,
  RaceInstance,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND = 'a2060000-0000-4000-8000-0000000000d1'
const REQUEST_ID = 'b2060000-0000-4000-8000-000000000001'

describe('The invoice of a recharge from Dropi (PostgreSQL, LOC-206)', () => {
  const envSnapshot = { ...process.env }
  let a: RaceInstance
  let trm: TrmSource
  let recharge: RechargeApp
  let member = ''

  const create = (overrides: object = {}) =>
    postRecharge(
      recharge,
      { brandId: BRAND, tokens: 10, requestId: REQUEST_ID, ...overrides },
      member,
    )
  const charge = (id: string, amount: number) =>
    postResult(recharge, id, {
      brandId: BRAND,
      status: 'charged',
      amount,
      dropiOperationId: `op-${id}`,
    })
  const stored = (id: string) => a.dataSource.getRepository(Payment).findOneByOrFail({ id })
  const clean = async () => {
    await a.dataSource.query(
      `DELETE FROM audit_log WHERE "entityType" = 'invoice'
       AND "entityId" IN (SELECT id::text FROM invoices WHERE "brandId" = $1)`,
      [BRAND],
    )
    await cleanBrand(a.dataSource, BRAND)
    await cleanBillingProfile(a.dataSource, BRAND)
  }

  beforeAll(async () => {
    Object.assign(process.env, { JWT_SECRET, ACCESS_SERVER })
    a = await startInstance()
    trm = await startTrmSource()
    recharge = await startRechargeApp(a.dataSource, trm, BRAND)
    member = recharge.jwt.sign({ id: MEMBER_ID, isSuperAdmin: false, brand: BRAND })
  })

  beforeEach(async () => {
    await clean()
    trm.reply = trmOk
    forgetCachedTrm(recharge)
    recharge.dian.sendInvoice.mockClear()
  })

  afterAll(async () => {
    await clean()
    await recharge?.app.close()
    await trm?.close()
    await stopInstance(a)
    process.env = { ...envSnapshot }
  })

  it('CA3: a manual recharge charged gets its own invoice in the same transaction', async () => {
    // R15: red when the charge stops writing the invoice: the brand has none.
    const created = await create()
    const { id, amount } = created.body.data

    const res = await charge(id, amount)

    expect(res.status).toBe(HttpStatus.OK)
    const invoices = await invoicesOf(a.dataSource, BRAND)
    expect(invoices).toHaveLength(1)
    const [invoice] = invoices
    expect(invoice.paymentId).toBe(id)
    expect(invoice.period).toBeNull()
    expect(invoice.invoiceNumber).toBe(manualRechargeInvoiceNumber(id))
    expect(Number(invoice.total)).toBe(amount)
    expect(invoice.items.map((item) => item.referenceId)).toEqual([id])
    expect(Number(invoice.items[0].total)).toBe(amount)
    const payment = await stored(id)
    expect(payment.status).toBe(PaymentStatus.COMPLETED)
    expect(payment.invoiceId).toBe(invoice.id)
    const [audit] = await auditOf(a.dataSource, id)
    expect(audit.changes).toMatchObject({ invoiceId: invoice.id })
    expect(recharge.dian.sendInvoice).toHaveBeenCalledWith(invoice.id)
  })

  it('a second charged report of a manual recharge writes no second invoice', async () => {
    // R15: red when a replay writes the invoice again: the brand ends with two or the replay fails.
    const { id, amount } = (await create()).body.data
    await charge(id, amount)

    const replay = await charge(id, amount)

    expect(replay.status).toBe(HttpStatus.OK)
    expect(await invoicesOf(a.dataSource, BRAND)).toHaveLength(1)
    expect(recharge.dian.sendInvoice).toHaveBeenCalledTimes(1)
    expect(await creditsOf(a.dataSource, id)).toHaveLength(1)
  })

  it('an invoice that cannot be written rolls the charge back, and the retry charges and invoices', async () => {
    // R15: red when the invoice leaves the charge transaction: tokens stay credited without invoice.
    const { id, amount } = (await create()).body.data
    const blocker = await a.dataSource.getRepository(Invoice).save({
      brandId: BRAND,
      invoiceNumber: manualRechargeInvoiceNumber(id),
      subtotal: 1,
      total: 1,
      currency: 'COP',
    })

    const failed = await charge(id, amount)

    expect(failed.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR)
    expect((await stored(id)).status).toBe(PaymentStatus.PENDING)
    expect((await stored(id)).invoiceId).toBeNull()
    expect(Number((await tokenWalletOf(a.dataSource, BRAND)).balance)).toBe(0)
    expect(await creditsOf(a.dataSource, id)).toHaveLength(0)
    expect(await auditOf(a.dataSource, id)).toHaveLength(0)
    expect(recharge.dian.sendInvoice).not.toHaveBeenCalled()

    await a.dataSource.getRepository(Invoice).delete({ id: blocker.id })
    const retried = await charge(id, amount)

    expect(retried.status).toBe(HttpStatus.OK)
    const [invoice] = await invoicesOf(a.dataSource, BRAND)
    expect(invoice.paymentId).toBe(id)
    expect(Number((await tokenWalletOf(a.dataSource, BRAND)).balance)).toBe(10)
  })

  it('an automatic recharge charged waits without invoice, and the close of its month takes it', async () => {
    // R15: red when the charge invoices automatic recharges too: one exists before the close.
    const { id, amount } = (await create({ automatic: true })).body.data

    expect((await charge(id, amount)).status).toBe(HttpStatus.OK)

    expect(await invoicesOf(a.dataSource, BRAND)).toHaveLength(0)
    expect((await stored(id)).invoiceId).toBeNull()
    expect(recharge.dian.sendInvoice).not.toHaveBeenCalled()

    const closes = recharge.moduleRef.get(AutomaticRechargeInvoiceService)
    // Paid now: a cutoff a second later closes it whatever today's date is.
    const cutoff = new Date((await stored(id)).paidAt.getTime() + 1000)
    const invoice = await closes.closeBrand(BRAND, '2026-11', cutoff)

    expect(invoice?.paymentId).toBeNull()
    expect((await stored(id)).invoiceId).toBe(invoice?.id)
    expect(recharge.dian.sendInvoice).toHaveBeenCalledWith(invoice?.id)
    const audits = await a.dataSource
      .getRepository(AuditLog)
      .findBy({ entityType: 'invoice', entityId: invoice!.id })
    expect(audits).toHaveLength(1)
  })

  it('a retry with the same requestId and another automatic value gets 409', async () => {
    // R15: red when the replay ignores `automatic`: the retry gets the manual recharge with 200.
    expect((await create()).status).toBe(HttpStatus.CREATED)

    const retry = await create({ automatic: true })

    expect(retry.status).toBe(HttpStatus.CONFLICT)
    const [only] = await rechargesOf(a.dataSource, BRAND)
    expect(only.metadata.dropiRecharge.automatic).toBe(false)
  })

  it.each([
    ['a null automatic', { automatic: null }],
    ['a string automatic', { automatic: 'true' }],
    ['a numeric automatic', { automatic: 1 }],
    ['an exponential automatic', { automatic: 1e-7 }],
  ])('%s is refused with 400 and creates nothing', async (_name, overrides) => {
    // R15: red when the DTO loses that rule: the request reaches the service and is not a 400.
    const res = await create(overrides)

    expect(res.status).toBe(HttpStatus.BAD_REQUEST)
    expect(await rechargesOf(a.dataSource, BRAND)).toHaveLength(0)
  })
})
