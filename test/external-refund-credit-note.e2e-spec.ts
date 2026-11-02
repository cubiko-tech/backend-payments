// R6: One responsibility, the credit note of a refund: each case is one state of that path.
import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { DianService } from '../src/dian/dian.service'
import { Invoice, InvoiceStatus, InvoiceType } from '../src/invoice/entities/invoice.entity'
import { InvoiceService } from '../src/invoice/invoice.service'
import {
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../src/payment/entities/payment.entity'
import { TasksService } from '../src/tasks/tasks.service'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import {
  onlyBrandPayments,
  paymentRow,
  seedExternalPurchase,
} from './support/external-purchase.fixture'
import {
  cleanBrand,
  createGate,
  movements,
  parkFirstCall,
  RaceInstance,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7106001-2222-4333-8444-555555555555'
const OLD_PLAN = 'dropi-roax'
const NEW_PLAN = 'dropi-roax-plus'

describe('Credit note of an invoiced external purchase refunded to the wallet (PostgreSQL)', () => {
  let a: RaceInstance
  let b: RaceInstance

  beforeAll(async () => {
    a = await startInstance({ realBilling: true })
    b = await startInstance({ realBilling: true })
  })

  const clean = async () => {
    const db = a.dataSource
    await db.query(
      `DELETE FROM audit_log WHERE "entityType" = 'invoice' AND "entityId" IN
       (SELECT id::text FROM invoices WHERE "brandId" = $1)`,
      [BRAND_ID],
    )
    await db.query('DELETE FROM invoices WHERE "brandId" = $1', [BRAND_ID])
    await cleanBrand(db, BRAND_ID)
  }

  beforeEach(clean)

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await clean()
    await stopInstance(a)
    await stopInstance(b)
  })

  const until = async (met: () => Promise<boolean>) => {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (await met()) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error('Condition not met within 5 seconds')
  }
  const invoicesOf = (where: Partial<Invoice>) =>
    a.dataSource.getRepository(Invoice).find({ where: { brandId: BRAND_ID, ...where } as any })
  const invoiceOf = async (paymentId: string) =>
    (await invoicesOf({ paymentId, type: InvoiceType.INVOICE }))[0]
  const notesOf = (invoiceId: string) =>
    a.dataSource.getRepository(Invoice).find({
      where: { creditNoteForId: invoiceId, type: InvoiceType.CREDIT_NOTE },
      relations: ['items'],
    })
  const allNotes = () => invoicesOf({ type: InvoiceType.CREDIT_NOTE })
  const auditsOf = (entityId: string, action: string) =>
    a.dataSource.getRepository(AuditLog).countBy({ entityId, action })
  const confirm = (id: string, on: RaceInstance = a) =>
    on.checkout.completeExternalPayment(id, { source: 'webhook' })
  const sweep = (on: RaceInstance = a) => {
    onlyBrandPayments(on, BRAND_ID)
    return on.tasks.retryMissingCreditNotes()
  }
  const dian = (on: RaceInstance = a) => on.moduleRef.get(DianService)
  const invoices = (on: RaceInstance = a) => on.moduleRef.get(InvoiceService)
  const noteHasCufe = async (invoiceId: string) => !!(await notesOf(invoiceId))[0]?.dianCufe

  const twoPurchases = async () => ({
    older: await seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN, { age: '30 minutes' }),
    newer: await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN, { age: '5 minutes' }),
  })

  /** Completed and at the DIAN; the newer one closes, hands it back and the sweep would credit it. */
  const handedBack = async () => {
    const { older, newer } = await twoPurchases()
    await confirm(older.id)
    const invoice = await invoiceOf(older.id)
    await until(async () => !!(await invoiceOf(older.id)).dianCufe)
    await confirm(newer.id)
    await until(async () => !!(await invoiceOf(newer.id))?.dianCufe)
    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.PROCESSING)
    return { older, newer, invoice }
  }

  /** Invoiced while the newer one closes, so it loses at completing, never sent to the DIAN. */
  const lostAfterInvoicing = async () => {
    const { older, newer } = await twoPurchases()
    const gate = createGate()
    parkFirstCall(a.checkout, 'generateInvoice', gate)
    const confirming = confirm(older.id)
    await gate.reached
    await confirm(newer.id)
    return { older, newer, finish: () => (gate.release(), confirming) }
  }

  /** Refunded with its credit note creation failed once. */
  const refundedWithFailedNote = async () => {
    const { older, invoice } = await handedBack()
    // R17: A database failure in the note cannot be provoked on demand; the real answer is `error`.
    jest
      .spyOn(invoices(), 'createCreditNote')
      .mockResolvedValueOnce({ error: 'Credit note insert failed' })
    await confirm(older.id)
    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    return { older, invoice }
  }

  it('E1 reverses the invoice in full and sends the note with the invoice number', async () => {
    // R15: red if settleLostPurchase stops issuing the note: the invoice stays without one.
    const { older, invoice } = await handedBack()
    // R17: The mock provider ignores the reference; only its input shows what Siigo would get.
    const provider = jest.spyOn((dian() as any).defaultProvider, 'sendCreditNote')
    const sends = jest.spyOn(dian(), 'sendInvoice')

    await confirm(older.id)

    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, older.id, TransactionType.CREDIT)).toHaveLength(1)
    await until(() => noteHasCufe(invoice.id))
    const [note, ...others] = await notesOf(invoice.id)
    expect(others).toHaveLength(0)
    expect(note.invoiceNumber).toBe(`NC-${invoice.invoiceNumber}`)
    expect(note.paymentId).toBeNull()
    expect(Number(note.total)).toBe(Number(invoice.total))
    expect(Number(note.taxTotal)).toBe(Number(invoice.taxTotal))
    expect(note.items).toHaveLength(1)
    expect(note.metadata.dianPending).toBeUndefined()
    expect((provider.mock.calls[0][0] as any).creditNoteForNumber).toBe(invoice.invoiceNumber)
    expect((provider.mock.calls[0][0] as any).items).toHaveLength(1)
    expect(sends.mock.calls.map(([id]) => id)).toEqual([note.id])
    expect(await auditsOf(older.id, 'credit_note_created')).toBe(1)
    const items = await a.dataSource.query('SELECT id FROM invoice_items WHERE "invoiceId" = $1', [
      invoice.id,
    ])
    expect(items).toHaveLength(1)
  })

  it('E2 creates nothing for a refund without an invoice', async () => {
    // R15: red if the missing invoice stops ending it: it would mark a failure on the payment.
    const { older, newer } = await twoPurchases()
    await confirm(newer.id)

    await confirm(older.id)

    const row = await paymentRow(a.dataSource, older.id)
    expect(row.status).toBe(PaymentStatus.REFUNDED)
    expect(await invoicesOf({ paymentId: older.id })).toHaveLength(0)
    expect(await allNotes()).toHaveLength(0)
    expect(row.metadata.creditNoteFailure).toBeUndefined()
    expect(await auditsOf(older.id, 'credit_note_failed')).toBe(0)
  })

  it('E3 refunds anyway when the note fails, and leaves the failure on the payment', async () => {
    // R15: red if the failure is rethrown: the confirmation rejects instead of answering false.
    const { older, invoice } = await refundedWithFailedNote()

    const row = await paymentRow(a.dataSource, older.id)
    expect(await movements(a.dataSource, older.id, TransactionType.CREDIT)).toHaveLength(1)
    expect(row.metadata.creditNoteFailure).toBe('Credit note insert failed')
    expect(await auditsOf(older.id, 'credit_note_failed')).toBe(1)
    expect(await notesOf(invoice.id)).toHaveLength(0)
  })

  it('E4 retries from the sweep with one note, one failure audit and the mark cleared', async () => {
    // R15: red if each failure audits again: the retry every five minutes floods the audit log.
    const { older, invoice } = await refundedWithFailedNote()
    jest.spyOn(invoices(), 'createCreditNote').mockResolvedValueOnce({ error: 'Failed again' })
    await sweep()
    expect(await auditsOf(older.id, 'credit_note_failed')).toBe(1)

    await sweep()
    await until(() => noteHasCufe(invoice.id))
    await sweep()

    const row = await paymentRow(a.dataSource, older.id)
    expect(await notesOf(invoice.id)).toHaveLength(1)
    expect(row.metadata.creditNoteFailure).toBeUndefined()
    expect(await auditsOf(older.id, 'credit_note_failed')).toBe(1)
  })

  it('E5 creates from the sweep a note lost to a crash after the refund', async () => {
    // R15: red if the sweep stops finding refunded purchases with an invoice and no note.
    const { older, invoice } = await handedBack()
    // R17: A crash between the refund and the note cannot be provoked on demand.
    jest.spyOn(a.checkout, 'issueRefundCreditNote').mockResolvedValueOnce(undefined)
    await confirm(older.id)
    expect(await notesOf(invoice.id)).toHaveLength(0)

    await sweep()

    expect(await notesOf(invoice.id)).toHaveLength(1)
    await until(() => noteHasCufe(invoice.id))
  })

  it('E6 leaves one note and one send when settle and sweep collide at the insert', async () => {
    // R15: red if the loser does not read the winner: it marks a failure over a note that exists.
    const { older, invoice } = await handedBack()
    let arrived = 0
    const both = createGate()
    for (const on of [a, b]) {
      const service = invoices(on)
      const create = service.create.bind(service)
      // R17: Only holding both at the insert provokes the collision on the unique number.
      jest.spyOn(service, 'create').mockImplementation(async (data: any) => {
        if (++arrived === 2) both.release()
        await both.wait
        return create(data)
      })
    }
    const sendsA = jest.spyOn(dian(a), 'sendInvoice')
    const sendsB = jest.spyOn(dian(b), 'sendInvoice')

    await Promise.all([confirm(older.id, a), until(async () => arrived === 1).then(() => sweep(b))])

    await until(() => noteHasCufe(invoice.id))
    const row = await paymentRow(a.dataSource, older.id)
    expect(await notesOf(invoice.id)).toHaveLength(1)
    expect(sendsA.mock.calls.length + sendsB.mock.calls.length).toBe(1)
    expect(row.metadata.creditNoteFailure).toBeUndefined()
    expect(await auditsOf(older.id, 'credit_note_failed')).toBe(0)
    expect(await auditsOf(older.id, 'credit_note_created')).toBe(1)
  })

  it('E7 does not touch again a refund that already has its note', async () => {
    // R15: red without NOT EXISTS in the sweep: each pass goes back over the finished refunds.
    const { older, invoice } = await handedBack()
    await confirm(older.id)
    await until(() => noteHasCufe(invoice.id))
    const issue = jest.spyOn(a.checkout, 'issueRefundCreditNote')
    const sends = jest.spyOn(dian(), 'sendInvoice')

    await sweep()

    expect(issue).not.toHaveBeenCalled()
    expect(sends).not.toHaveBeenCalled()
    expect(await notesOf(invoice.id)).toHaveLength(1)
  })

  it('E8 holds the note until the DIAN answered for an invoice it never received', async () => {
    // R15: red if the invoice send is not awaited: the note goes out while the invoice is held.
    const { older, finish } = await lostAfterInvoicing()
    const held = createGate()
    const realSend = dian().sendInvoice.bind(dian())
    // R17: The mock answers at once; only holding the invoice shows who waits for whom.
    const sends = jest.spyOn(dian(), 'sendInvoice').mockImplementation(async (id: string) => {
      const row = await a.dataSource.getRepository(Invoice).findOneBy({ id })
      if (row!.type === InvoiceType.INVOICE) {
        held.arrive()
        await held.wait
      }
      return realSend(id)
    })

    await finish()
    await held.reached
    const invoice = await invoiceOf(older.id)
    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(sends).toHaveBeenCalledTimes(1)

    held.release()
    await until(() => noteHasCufe(invoice.id))
    expect(sends).toHaveBeenCalledTimes(2)
    expect((await invoiceOf(older.id)).dianCufe).toBeTruthy()
  })

  it('E9 keeps the note flagged and unsent when the DIAN rejects the invoice', async () => {
    // R15: red if the note is sent although its invoice was rejected.
    const { older, finish } = await lostAfterInvoicing()
    // R17: The mock provider always accepts; a rejection only exists by forcing it.
    jest.spyOn((dian() as any).defaultProvider, 'sendInvoice').mockResolvedValueOnce({
      success: false,
      cufe: '',
      status: 'rejected',
      dianMessage: 'Rejected',
    })
    const noteSends = jest.spyOn((dian() as any).defaultProvider, 'sendCreditNote')

    await finish()
    await until(async () => (await auditsOf(older.id, 'credit_note_dian_failed')) === 1)

    const [note] = await notesOf((await invoiceOf(older.id)).id)
    expect(note.dianCufe).toBeNull()
    expect(note.metadata.dianPending).toBe(true)
    expect(noteSends).not.toHaveBeenCalled()
    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, older.id, TransactionType.CREDIT)).toHaveLength(1)
  })

  it('E10 leaves the mark on a note whose send never finished', async () => {
    // R15: red if the mark is not written ahead of sending: a crash here would leave no trace.
    const { older, invoice } = await handedBack()
    // R17: A process dying mid-send is a call that never answers.
    jest.spyOn(dian(), 'sendInvoice').mockReturnValueOnce(new Promise(() => undefined))

    await confirm(older.id)

    const [note] = await notesOf(invoice.id)
    expect(note.dianCufe).toBeNull()
    expect(note.metadata.dianPending).toBe(true)
    expect(await auditsOf(older.id, 'credit_note_created')).toBe(1)
  })

  it('E11 does not resend an invoice that already reached the DIAN', async () => {
    // R15: red if the CUFE stops deciding: sendInvoice throws on the invoice and no note goes out.
    const { older, invoice } = await handedBack()
    const sends = jest.spyOn(dian(), 'sendInvoice')

    await confirm(older.id)
    await until(() => noteHasCufe(invoice.id))

    expect(sends).not.toHaveBeenCalledWith(invoice.id)
    expect(await auditsOf(older.id, 'credit_note_dian_failed')).toBe(0)
  })

  it('E12 creates the note when the invoice appears after another instance refunded', async () => {
    // R15: red if only a refund made by this call issues the note: the late invoice has none.
    const { older, finish } = await lostAfterInvoicing()
    await confirm(older.id, b)
    expect(await statusOf(a.dataSource, older.id)).toBe(PaymentStatus.REFUNDED)
    expect(await allNotes()).toHaveLength(0)

    await finish()

    const invoice = await invoiceOf(older.id)
    expect(await notesOf(invoice.id)).toHaveLength(1)
    await until(() => noteHasCufe(invoice.id))
  })

  describe('invoices that stay alive', () => {
    const seedInvoiced = async (overrides: object) => {
      const payment = await seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN, {
        overrides,
      })
      const { data } = await invoices().create({
        brandId: BRAND_ID,
        paymentId: payment.id,
        invoiceNumber: `CK-LOC106-${payment.id}`,
        subtotal: 100,
        taxTotal: 19,
        total: 119,
        currency: 'COP',
        status: InvoiceStatus.PAID,
      })
      await sweep()
      return data!
    }
    const refunded = { status: PaymentStatus.REFUNDED }

    it('E13 leaves the invoice of a completed external purchase without a note', async () => {
      // R15: red without status = refunded in the sweep: it reverses a live invoice.
      const invoice = await seedInvoiced({ status: PaymentStatus.COMPLETED })
      expect(await notesOf(invoice.id)).toHaveLength(0)
    })

    it('E14 leaves the invoice of a refunded recharge without a note', async () => {
      // R15: red without purpose = plan_purchase in the sweep: it reverses a recharge invoice.
      const invoice = await seedInvoiced({ ...refunded, purpose: PaymentPurpose.WALLET_RECHARGE })
      expect(await notesOf(invoice.id)).toHaveLength(0)
    })

    it('E15 leaves the invoice of a refunded wallet purchase without a note', async () => {
      // R15: red without the provider filter in the sweep: it reaches wallet purchases.
      const invoice = await seedInvoiced({ ...refunded, provider: PaymentProvider.WALLET })
      expect(await notesOf(invoice.id)).toHaveLength(0)
    })
  })

  it('E16 schedules the sweep', () => {
    // R15: red without @Cron: every other case calls the method by hand and stays green.
    const cron = Reflect.getMetadata(
      'SCHEDULE_CRON_OPTIONS',
      TasksService.prototype.retryMissingCreditNotes,
    )
    expect(cron).toBeDefined()
  })
})
