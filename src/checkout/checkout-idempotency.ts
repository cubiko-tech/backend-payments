import { HttpStatus } from '@nestjs/common'
import { Repository } from 'typeorm'

import { Payment, PaymentProvider, PaymentStatus } from '../payment/entities/payment.entity'
import { RequestException } from '../shared/exception/request.exception'
import type { CheckoutRequest, CheckoutResult } from './checkout.service'
import { checkoutExpiryHours } from './checkout-expiry'
import { LOST_TO_NEWER_PURCHASE_FLAG } from './external-payment-close'

export type InFlightCheckoutsMap = Map<
  string,
  { fingerprint: string; promise: Promise<CheckoutResult> }
>

export type RetryFailedPaymentCallback = (existing: Payment) => Promise<CheckoutResult>

export const MAX_IDEMPOTENCY_KEY_LENGTH = 255

export function normalizeIdempotencyKey(raw?: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new RequestException(
      {
        code: 'INVALID_IDEMPOTENCY_KEY',
        message: `Idempotency-Key must not exceed ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      },
      HttpStatus.BAD_REQUEST,
    )
  }
  return trimmed
}

export function canRetryFailedIdempotentPayment(payment: Payment): boolean {
  const hasStoredFingerprint =
    typeof payment.metadata?.idempotencyFingerprint === 'string' &&
    payment.metadata.idempotencyFingerprint.length > 0
  return hasStoredFingerprint && !payment.providerPaymentId && !payment.metadata?.amountMismatch
}

/**
 * When the payment was born. `createdAt` moves on a retry without a debit, so the first retry
 * stores the original in `metadata.firstAttemptAt`.
 */
export function paymentBirth(payment: Payment): Date {
  return new Date(payment.metadata?.firstAttemptAt ?? payment.createdAt)
}

/** Whether the stored price can still be charged. An unreadable birth closes the window. */
export function isRetryWindowOpen(payment: Payment, now = new Date()): boolean {
  const elapsedMs = now.getTime() - paymentBirth(payment).getTime()
  return elapsedMs <= checkoutExpiryHours() * 60 * 60 * 1000
}

export function createRetryExpiredException(payment: Payment): RequestException {
  return new RequestException(
    {
      code: 'IDEMPOTENT_RETRY_EXPIRED',
      message:
        'This payment can no longer be retried: place a new order with another Idempotency-Key',
      paymentId: payment.id,
    },
    HttpStatus.CONFLICT,
  )
}

export function createFailedExternalIdempotentPaymentException(payment: Payment): RequestException {
  const isAmountMismatch = Boolean(payment.metadata?.amountMismatch)
  return new RequestException(
    {
      code: isAmountMismatch ? 'PROVIDER_AMOUNT_MISMATCH' : 'IDEMPOTENT_PAYMENT_FAILED',
      message:
        payment.failureReason ||
        'Previous payment attempt with this Idempotency-Key failed after creating an external provider session',
      paymentId: payment.id,
    },
    HttpStatus.CONFLICT,
  )
}

export function createIncompleteIdempotentCheckoutException(payment: Payment): RequestException {
  return new RequestException(
    {
      code: 'IDEMPOTENT_CHECKOUT_INCOMPLETE',
      message: 'Payment was marked completed without a stored checkout result',
      paymentId: payment.id,
    },
    HttpStatus.CONFLICT,
  )
}

/** The debit is registered and the close or the sweep still has to settle it. */
export function createInProgressIdempotentCheckoutException(payment: Payment): RequestException {
  return new RequestException(
    {
      code: 'IDEMPOTENT_CHECKOUT_IN_PROGRESS',
      message: 'Payment is debited and still being settled',
      paymentId: payment.id,
    },
    HttpStatus.CONFLICT,
  )
}

export function isUniqueConstraintViolation(error: any): boolean {
  return error?.code === '23505' || error?.driverError?.code === '23505'
}

export function createIdempotencyConflictException(): RequestException {
  return new RequestException(
    {
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message: 'Idempotency-Key was already used with a different checkout request body',
    },
    HttpStatus.CONFLICT,
  )
}

/**
 * Serializes the normalized checkout payload into a deterministic JSON string so
 * retries with the same `Idempotency-Key` can detect mutated request parameters
 * even when optional fields are omitted vs. null.
 */
export function buildIdempotencyFingerprint(req: CheckoutRequest): string {
  return JSON.stringify({
    userId: req.userId || null,
    purpose: req.purpose || null,
    provider: req.provider || null,
    planSlug: req.planSlug || null,
    amount: req.amount !== undefined && req.amount !== null ? Number(req.amount) : null,
    currency: req.currency ? String(req.currency).toUpperCase() : null,
    walletId: req.walletId || null,
    successUrl: req.successUrl || null,
    cancelUrl: req.cancelUrl || null,
    buyer: req.buyer
      ? {
          firstName: req.buyer.firstName || null,
          lastName: req.buyer.lastName || null,
          email: req.buyer.email || null,
          phoneNumber: req.buyer.phoneNumber || null,
        }
      : null,
    renewal: Boolean(req.renewal),
    // Only when present: payments stored before token packages keep their fingerprint.
    ...(req.packageId ? { packageId: req.packageId } : {}),
    ...(req.tokens !== undefined && req.tokens !== null ? { tokens: Number(req.tokens) } : {}),
  })
}

/**
 * Verifies that an incoming retry matches the original checkout payload, falling
 * back to column-level comparisons for legacy payment rows created before
 * `metadata.idempotencyFingerprint` was persisted.
 */
export function assertMatchingIdempotencyPayload(
  existing: Payment,
  req: CheckoutRequest,
  incomingFingerprint?: string,
): void {
  const storedFingerprint = existing.metadata?.idempotencyFingerprint
  if (typeof storedFingerprint === 'string' && incomingFingerprint) {
    if (storedFingerprint !== incomingFingerprint) {
      throw createIdempotencyConflictException()
    }
    return
  }

  if (existing.purpose && req.purpose && String(existing.purpose) !== String(req.purpose)) {
    throw createIdempotencyConflictException()
  }
  if (existing.provider && req.provider && String(existing.provider) !== String(req.provider)) {
    throw createIdempotencyConflictException()
  }
  if ((existing.purposeId || null) !== (req.planSlug || null)) {
    throw createIdempotencyConflictException()
  }
  if ((existing.walletId || null) !== (req.walletId || null)) {
    throw createIdempotencyConflictException()
  }
  if (
    req.amount !== undefined &&
    existing.amount !== undefined &&
    Number(existing.amount) !== Number(req.amount)
  ) {
    throw createIdempotencyConflictException()
  }
  if (
    req.currency !== undefined &&
    existing.currency !== undefined &&
    String(existing.currency).toUpperCase() !== String(req.currency).toUpperCase()
  ) {
    throw createIdempotencyConflictException()
  }
  if (
    req.tokens !== undefined &&
    existing.metadata?.tokenAmount?.purchasedTokens !== undefined &&
    Number(existing.metadata.tokenAmount.purchasedTokens) !== Number(req.tokens)
  ) {
    throw createIdempotencyConflictException()
  }
}

async function resolvePaymentStateOutcome(
  payment: Payment,
  retryFailedPayment?: RetryFailedPaymentCallback,
): Promise<CheckoutResult | null> {
  if (payment.status === PaymentStatus.FAILED) {
    if (!canRetryFailedIdempotentPayment(payment)) {
      if (!payment.metadata?.amountMismatch && !isRetryWindowOpen(payment)) {
        throw createRetryExpiredException(payment)
      }
      throw createFailedExternalIdempotentPaymentException(payment)
    }
    if (retryFailedPayment) {
      return retryFailedPayment(payment)
    }
  }

  if (payment.status === PaymentStatus.COMPLETED) {
    if (payment.metadata?.checkoutResult) {
      return payment.metadata.checkoutResult as CheckoutResult
    }
    throw createIncompleteIdempotentCheckoutException(payment)
  }

  // Ahead of the stored result: a purchase handed back to the sweep keeps its old `completed`.
  if (
    payment.status === PaymentStatus.PROCESSING &&
    (payment.provider === PaymentProvider.WALLET ||
      payment.paidAt ||
      payment.metadata?.[LOST_TO_NEWER_PURCHASE_FLAG])
  ) {
    throw createInProgressIdempotentCheckoutException(payment)
  }

  // A credited purchase may keep the `completed` or the pending checkout it stored before.
  if (payment.status === PaymentStatus.REFUNDED) {
    return null
  }

  if (payment.metadata?.checkoutResult) {
    return payment.metadata.checkoutResult as CheckoutResult
  }

  return null
}

/**
 * Replays the outcome of a previously registered idempotent checkout, awaiting
 * the in-process execution promise when the original request is still in flight.
 * `hasDebit` turns a `pending` wallet payment with its debit into a 409; a caller that
 * knows the payment has a live owner omits it and gets the `pending` result.
 */
export async function resolveExistingIdempotentPayment(
  existing: Payment,
  req: CheckoutRequest,
  paymentRepo: Pick<Repository<Payment>, 'findOne'>,
  inFlightCheckouts: InFlightCheckoutsMap,
  incomingFingerprint?: string,
  retryFailedPayment?: RetryFailedPaymentCallback,
  hasDebit?: (payment: Payment) => Promise<boolean>,
): Promise<CheckoutResult> {
  assertMatchingIdempotencyPayload(existing, req, incomingFingerprint)

  const inFlightKey = req.idempotencyKey ? `${req.brandId}:${req.idempotencyKey}` : undefined
  if (inFlightKey) {
    const active = inFlightCheckouts.get(inFlightKey)
    if (active) {
      if (incomingFingerprint && active.fingerprint !== incomingFingerprint) {
        throw createIdempotencyConflictException()
      }
      return active.promise
    }
  }

  const immediateOutcome = await resolvePaymentStateOutcome(existing, retryFailedPayment)
  if (immediateOutcome !== null) {
    return immediateOutcome
  }

  if (existing.status === PaymentStatus.PENDING && req.idempotencyKey) {
    const refreshed = await paymentRepo.findOne({
      where: { brandId: req.brandId, idempotencyKey: req.idempotencyKey },
    })
    if (refreshed) {
      const refreshedOutcome = await resolvePaymentStateOutcome(refreshed, retryFailedPayment)
      if (refreshedOutcome !== null) {
        return refreshedOutcome
      }
      if (
        refreshed.provider === PaymentProvider.WALLET &&
        refreshed.status === PaymentStatus.PENDING &&
        (await hasDebit?.(refreshed))
      ) {
        throw createInProgressIdempotentCheckoutException(refreshed)
      }
      return {
        paymentId: refreshed.id,
        status: refreshed.status,
        ...(refreshed.checkoutUrl ? { checkoutUrl: refreshed.checkoutUrl } : {}),
      }
    }
  }

  return {
    paymentId: existing.id,
    status: existing.status,
    // A credited purchase must not send the buyer back to pay.
    ...(existing.checkoutUrl && existing.status !== PaymentStatus.REFUNDED
      ? { checkoutUrl: existing.checkoutUrl }
      : {}),
  }
}

export async function handleConcurrentIdempotentCheckout(
  req: CheckoutRequest,
  paymentRepo: Pick<Repository<Payment>, 'findOne'>,
  inFlightCheckouts: InFlightCheckoutsMap,
  incomingFingerprint?: string,
  inFlightKey?: string,
  retryFailedPayment?: RetryFailedPaymentCallback,
): Promise<CheckoutResult> {
  if (inFlightKey) {
    const active = inFlightCheckouts.get(inFlightKey)
    if (active) {
      if (incomingFingerprint && active.fingerprint !== incomingFingerprint) {
        throw createIdempotencyConflictException()
      }
      return active.promise
    }
  }

  const existing = await paymentRepo.findOne({
    where: { brandId: req.brandId, idempotencyKey: req.idempotencyKey },
  })
  if (existing) {
    return resolveExistingIdempotentPayment(
      existing,
      req,
      paymentRepo,
      inFlightCheckouts,
      incomingFingerprint,
      retryFailedPayment,
    )
  }

  throw createIdempotencyConflictException()
}
