import { AuditLog } from '../src/audit/entities/auditLog.entity'
import { DianAlreadySentError, DianSendInFlightError, DianService } from '../src/dian/dian.service'
import { Invoice, InvoiceType } from '../src/invoice/entities/invoice.entity'
import { InvoiceService } from '../src/invoice/invoice.service'
import { PaymentStatus } from '../src/payment/entities/payment.entity'
import { TransactionType } from '../src/transaction/entities/transaction.entity'
import { seedExternalPurchase } from './support/external-purchase.fixture'
import {
  cleanBrand,
  createGate,
  Gate,
  movements,
  parkFirstCall,
  RaceInstance,
  startInstance,
  statusOf,
  stopInstance,
} from './support/wallet-race.fixture'

const BRAND_ID = 'a7106002-2222-4333-8444-555555555555'
const OLD_PLAN = 'dropi-roax'
const NEW_PLAN = 'dropi-roax-plus'

describe('One send per document to the DIAN during a refund (PostgreSQL)', () => {
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
  const dian = (on: RaceInstance = a) => on.moduleRef.get(DianService)
  const provider = (on: RaceInstance = a) => (dian(on) as any).defaultProvider
  const invoiceOf = (paymentId: string) =>
    a.dataSource.getRepository(Invoice).findOneByOrFail({ paymentId, type: InvoiceType.INVOICE })
  const noteOf = (invoiceId: string) =>
    a.dataSource.getRepository(Invoice).findOneBy({ creditNoteForId: invoiceId })
  const failedAudits = (paymentId: string) =>
    a.dataSource
      .getRepository(AuditLog)
      .countBy({ entityId: paymentId, action: 'credit_note_dian_failed' })
  const confirm = (id: string) => a.checkout.completeExternalPayment(id, { source: 'webhook' })
  const sendsOf = (spy: jest.SpyInstance, invoiceNumber: string) =>
    spy.mock.calls.filter(([data]) => data.invoiceNumber === invoiceNumber).length

  /**
   * A completed purchase whose only send is held at the provider, handed back and refunded.
   * `firstAnswer` is what that held send answers once released; the real provider by default.
   */
  const refundedWithSendInFlight = async (gate: Gate, firstAnswer?: object) => {
    const older = await seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN, {
      age: '30 minutes',
    })
    const newer = await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN, { age: '5 minutes' })
    const realSend = provider().sendInvoice.bind(provider())
    let held = false
    // R17: Only holding the provider keeps a send in flight, and the mock never rejects by itself.
    const invoiceSends = jest
      .spyOn(provider(), 'sendInvoice')
      .mockImplementation(async (data: any) => {
        if (held) return realSend(data)
        held = true
        gate.arrive()
        await gate.wait
        return firstAnswer ?? realSend(data)
      })
    const noteSends = jest.spyOn(provider(), 'sendCreditNote')
    await confirm(older.id)
    await gate.reached
    const invoice = await invoiceOf(older.id)
    await confirm(newer.id)
    await until(async () => !!(await invoiceOf(newer.id)).dianCufe)
    await confirm(older.id)
    await until(async () => !!(await noteOf(invoice.id)))
    return { older, invoice, invoiceSends, noteSends }
  }

  const expectMoneyBack = async (paymentId: string) => {
    expect(await statusOf(a.dataSource, paymentId)).toBe(PaymentStatus.REFUNDED)
    expect(await movements(a.dataSource, paymentId, TransactionType.CREDIT)).toHaveLength(1)
  }

  it('C1 sends the note once, after the send in flight got the invoice its CUFE', async () => {
    // R15: red if the refund sends the invoice without the claim: the provider gets it twice.
    const gate = createGate()
    const { older, invoice, invoiceSends, noteSends } = await refundedWithSendInFlight(gate)

    await expectMoneyBack(older.id)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(noteSends).not.toHaveBeenCalled()

    gate.release()
    await until(async () => !!(await noteOf(invoice.id))?.dianCufe)

    expect(sendsOf(invoiceSends, invoice.invoiceNumber)).toBe(1)
    expect(noteSends).toHaveBeenCalledTimes(1)
    expect(await failedAudits(older.id)).toBe(0)
    const settled = await invoiceOf(older.id)
    expect(settled.dianCufe).toBeTruthy()
    expect(settled.metadata?.dianSendingAt).toBeUndefined()
    expect((await noteOf(invoice.id))!.metadata.dianPending).toBeUndefined()
  })

  it('C2 keeps the note flagged and unsent when the send in flight is rejected', async () => {
    // R15: red if an unanswered wait lets the note go: it reaches the DIAN over an unknown invoice.
    const gate = createGate()
    const rejected = { success: false, cufe: '', status: 'rejected', dianMessage: 'Rejected' }
    const { older, invoice, invoiceSends, noteSends } = await refundedWithSendInFlight(
      gate,
      rejected,
    )

    gate.release()
    await until(async () => (await failedAudits(older.id)) === 1)

    const note = (await noteOf(invoice.id))!
    expect(note.dianCufe).toBeNull()
    expect(note.metadata.dianPending).toBe(true)
    expect(noteSends).not.toHaveBeenCalled()
    expect(sendsOf(invoiceSends, invoice.invoiceNumber)).toBe(1)
    await expectMoneyBack(older.id)
  })

  it('C3 leaves the note unsent when the send in flight never answers', async () => {
    // R15: red if the wait has no deadline or ignores it: nothing ever says the note is stuck.
    const gate = createGate()
    const previous = (a.checkout as any).dianInFlightWaitMs
    ;(a.checkout as any).dianInFlightWaitMs = 200
    try {
      const { older, invoice, invoiceSends, noteSends } = await refundedWithSendInFlight(gate)

      await until(async () => (await failedAudits(older.id)) === 1)

      const note = (await noteOf(invoice.id))!
      expect(note.dianCufe).toBeNull()
      expect(note.metadata.dianPending).toBe(true)
      expect(noteSends).not.toHaveBeenCalled()
      expect(sendsOf(invoiceSends, invoice.invoiceNumber)).toBe(1)
      await expectMoneyBack(older.id)
    } finally {
      ;(a.checkout as any).dianInFlightWaitMs = previous
    }
  })

  it('C4 sends the note when the CUFE arrives between the read and the send', async () => {
    // R15: red if an already sent invoice stops counting as sent: the note never leaves.
    const older = await seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN, {
      age: '30 minutes',
    })
    const newer = await seedExternalPurchase(a.dataSource, BRAND_ID, NEW_PLAN, { age: '5 minutes' })
    await confirm(older.id)
    const invoice = await invoiceOf(older.id)
    await until(async () => !!(await invoiceOf(older.id)).dianCufe)
    await confirm(newer.id)
    // R17: Only a forced stale read holds this interleaving still.
    jest
      .spyOn(a.moduleRef.get(InvoiceService), 'findInvoiceOfPayment')
      .mockResolvedValueOnce({ ...invoice, dianCufe: null } as Invoice)

    await confirm(older.id)
    await until(async () => !!(await noteOf(invoice.id))?.dianCufe)

    expect(await failedAudits(older.id)).toBe(0)
  })

  describe('the claim of a document', () => {
    const invoiced = async () => {
      const payment = await seedExternalPurchase(a.dataSource, BRAND_ID, OLD_PLAN)
      const { data } = await a.moduleRef.get(InvoiceService).create({
        brandId: BRAND_ID,
        paymentId: payment.id,
        invoiceNumber: `CK-CLAIM-${payment.id}`,
        subtotal: 100,
        taxTotal: 19,
        total: 119,
        currency: 'COP',
      })
      return data!
    }
    const ageClaim = (id: string, interval: string) =>
      a.dataSource.query(
        `UPDATE invoices SET metadata = jsonb_build_object('dianSendingAt', (now() - $2::interval)::text)
         WHERE id = $1`,
        [id, interval],
      )

    it('C5 lets one of two instances send, and the other is told it is in flight', async () => {
      // R15: red if the claim is not exclusive: both instances reach the provider.
      const invoice = await invoiced()
      const gate = createGate()
      parkFirstCall(provider(a), 'sendInvoice', gate)
      const first = dian(a).sendInvoice(invoice.id)
      await gate.reached
      const other = jest.spyOn(provider(b), 'sendInvoice')

      await expect(dian(b).sendInvoice(invoice.id)).rejects.toBeInstanceOf(DianSendInFlightError)

      expect(other).not.toHaveBeenCalled()
      gate.release()
      await first
      await expect(dian(b).sendInvoice(invoice.id)).rejects.toBeInstanceOf(DianAlreadySentError)
    })

    it('C6 releases the claim when the provider throws, so a person can send it again', async () => {
      // R15: red if the claim outlives the attempt: the document stays in flight forever.
      const invoice = await invoiced()
      // R17: A provider crash cannot be provoked on the mock.
      jest.spyOn(provider(), 'sendInvoice').mockRejectedValueOnce(new Error('Provider down'))

      await expect(dian().sendInvoice(invoice.id)).rejects.toThrow('Provider down')

      await expect(dian().sendInvoice(invoice.id)).resolves.toMatchObject({ success: true })
    })

    it('C7 takes over a claim left by a dead process only on request', async () => {
      // R15: red if a stale claim is taken without asking: an automatic send could duplicate it.
      const invoice = await invoiced()
      await ageClaim(invoice.id, '1 hour')

      await expect(dian().sendInvoice(invoice.id)).rejects.toBeInstanceOf(DianSendInFlightError)

      const sent = await dian().sendInvoice(invoice.id, { reclaimStale: true })
      expect(sent.success).toBe(true)
    })

    it('C8 does not take over a recent claim even on request', async () => {
      // R15: red if the age stops deciding: a manual send duplicates one still running.
      const invoice = await invoiced()
      await ageClaim(invoice.id, '10 seconds')

      await expect(dian().sendInvoice(invoice.id, { reclaimStale: true })).rejects.toBeInstanceOf(
        DianSendInFlightError,
      )
    })
  })
})
