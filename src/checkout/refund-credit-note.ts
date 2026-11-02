import { DataSource } from 'typeorm'

import { AuditService } from '../audit/audit.service'
import { DianAlreadySentError, DianSendInFlightError, DianService } from '../dian/dian.service'
import { DIAN_PENDING_FLAG, DIAN_SENDING_FLAG, Invoice } from '../invoice/entities/invoice.entity'
import { InvoiceService } from '../invoice/invoice.service'

/** `metadata` key of a refunded payment whose credit note could not be created yet. */
export const CREDIT_NOTE_FAILURE_KEY = 'creditNoteFailure'

export interface RefundCreditNoteDeps {
  invoiceService: Pick<InvoiceService, 'findInvoiceOfPayment' | 'createCreditNote'>
  dianService: Pick<DianService, 'sendInvoice'>
  auditService: Pick<AuditService, 'log'>
  dataSource: DataSource
  logger: { error: (message: string) => void }
  canSendToDian: (invoiceId: string, currency: string) => boolean
  dianInFlightWaitMs: number
}

const IN_FLIGHT_POLL_MS = 100

/** Runs a step whose failure must not undo or hide what already happened. */
async function quietly(step: () => Promise<unknown>, what: string, deps: RefundCreditNoteDeps) {
  try {
    await step()
  } catch (error: any) {
    deps.logger.error(`refundCreditNote: ${what} failed: ${error?.message ?? error}`)
  }
}

function audit(
  paymentId: string,
  action: string,
  details: Record<string, unknown>,
  description: string,
  deps: RefundCreditNoteDeps,
) {
  return deps.auditService.log('system', action, 'payment', paymentId, details, description)
}

/** Marks the payment and audits only the first failure: the sweep retries every few minutes. */
async function recordCreationFailure(paymentId: string, why: string, deps: RefundCreditNoteDeps) {
  const [rows] = await deps.dataSource.query(
    `UPDATE payments
     SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY[$2::text], to_jsonb($3::text))
     WHERE id = $1 AND metadata->>$2::text IS NULL
     RETURNING id`,
    [paymentId, CREDIT_NOTE_FAILURE_KEY, why],
  )
  if (rows.length > 0) {
    const description = `Credit note of refunded payment ${paymentId} failed: ${why}`
    await audit(paymentId, 'credit_note_failed', { error: why }, description, deps)
  }
}

function clearCreationFailure(paymentId: string, deps: RefundCreditNoteDeps) {
  return deps.dataSource.query(
    `UPDATE payments SET metadata = metadata - $2::text
     WHERE id = $1 AND metadata->>$2::text IS NOT NULL`,
    [paymentId, CREDIT_NOTE_FAILURE_KEY],
  )
}

/** Waits out a send of the invoice started elsewhere. Answers why the note cannot go, or null. */
async function waitForInFlightInvoice(paymentId: string, deps: RefundCreditNoteDeps) {
  const deadline = Date.now() + deps.dianInFlightWaitMs
  while (Date.now() < deadline) {
    const current = await deps.invoiceService.findInvoiceOfPayment(paymentId)
    if (current?.dianCufe) {
      return null
    }
    if (!current?.metadata?.[DIAN_SENDING_FLAG]) {
      return 'the invoice send in flight did not get it accepted'
    }
    await new Promise((resolve) => setTimeout(resolve, IN_FLIGHT_POLL_MS))
  }
  return `the invoice send in flight did not answer in ${deps.dianInFlightWaitMs} ms`
}

/** Gets the invoice to the DIAN, once. Answers why the note cannot go, or null if it can. */
async function invoiceBlockingNote(
  paymentId: string,
  invoice: Invoice,
  deps: RefundCreditNoteDeps,
): Promise<string | null> {
  if (invoice.dianCufe) {
    return null
  }
  try {
    const sent = await deps.dianService.sendInvoice(invoice.id)
    return sent.success ? null : `invoice rejected: ${sent.dianMessage}`
  } catch (error) {
    if (error instanceof DianAlreadySentError) {
      return null
    }
    if (error instanceof DianSendInFlightError) {
      return waitForInFlightInvoice(paymentId, deps)
    }
    throw error
  }
}

/**
 * The invoice goes first when it never reached the DIAN: a note over a document the DIAN does not
 * know means nothing. A failure leaves the note flagged and audited, with no automatic resend: a
 * lost answer would duplicate a fiscal document.
 */
async function sendToDian(
  paymentId: string,
  invoice: Invoice,
  noteId: string,
  deps: RefundCreditNoteDeps,
) {
  const reportFailure = (why: string) =>
    quietly(
      () =>
        audit(
          paymentId,
          'credit_note_dian_failed',
          { invoiceId: invoice.id, creditNoteId: noteId, error: why },
          `Credit note ${noteId} did not reach the DIAN: ${why}`,
          deps,
        ),
      'its failure audit',
      deps,
    )
  try {
    const blocked = await invoiceBlockingNote(paymentId, invoice, deps)
    if (blocked) {
      return await reportFailure(blocked)
    }
    const note = await deps.dianService.sendInvoice(noteId)
    if (!note.success) {
      await reportFailure(`note rejected: ${note.dianMessage}`)
    }
  } catch (error: any) {
    await reportFailure(error?.message ?? String(error))
  }
}

/**
 * Creates the credit note of a refunded purchase's invoice, if it has one, and starts its way to
 * the DIAN without waiting for it: Siigo can take a minute and a webhook is behind this. The money
 * is already back, so a failure never throws: it stays on the payment and the sweep retries.
 */
export async function issueRefundCreditNote(paymentId: string, deps: RefundCreditNoteDeps) {
  let created: { invoice: Invoice; noteId: string; send: boolean } | null = null
  try {
    const invoice = await deps.invoiceService.findInvoiceOfPayment(paymentId)
    if (!invoice) {
      return
    }
    const send = deps.canSendToDian(invoice.id, invoice.currency)
    const result = await deps.invoiceService.createCreditNote(invoice.id, {
      paymentId,
      ...(send ? { [DIAN_PENDING_FLAG]: true } : {}),
    })
    if (!result.data) {
      throw new Error(result.error ?? 'credit note was not created')
    }
    await quietly(() => clearCreationFailure(paymentId, deps), 'clearing its mark', deps)
    if (result.created) {
      created = { invoice, noteId: result.data.id, send }
    }
  } catch (error: any) {
    const why = error?.message ?? String(error)
    deps.logger.error(`refundCreditNote: payment ${paymentId}: ${why}`)
    await quietly(() => recordCreationFailure(paymentId, why, deps), 'recording the failure', deps)
    return
  }
  if (!created) {
    return
  }
  const { invoice, noteId, send } = created
  await quietly(
    () =>
      audit(
        paymentId,
        'credit_note_created',
        { invoiceId: invoice.id, creditNoteId: noteId, dianPending: send },
        `Credit note ${noteId} created for invoice ${invoice.invoiceNumber}`,
        deps,
      ),
    'its audit',
    deps,
  )
  if (send) {
    void sendToDian(paymentId, invoice, noteId, deps)
  }
}
