import { HttpStatus } from '@nestjs/common'
import { Repository } from 'typeorm'

import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { RequestException } from '../shared/exception/request.exception'
import type { CheckoutRequest, CheckoutResult } from './checkout.service'

export type InFlightCheckoutsMap = Map<
  string,
  { fingerprint: string; promise: Promise<CheckoutResult> }
>

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
}

/**
 * Replays the outcome of a previously registered idempotent checkout, awaiting
 * the in-process execution promise when the original request is still in flight.
 */
export async function resolveExistingIdempotentPayment(
  existing: Payment,
  req: CheckoutRequest,
  paymentRepo: Pick<Repository<Payment>, 'findOne'>,
  inFlightCheckouts: InFlightCheckoutsMap,
  incomingFingerprint?: string,
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

  if (existing.metadata?.checkoutResult) {
    return existing.metadata.checkoutResult as CheckoutResult
  }

  if (existing.status === PaymentStatus.PENDING && req.idempotencyKey) {
    const refreshed = await paymentRepo.findOne({
      where: { brandId: req.brandId, idempotencyKey: req.idempotencyKey },
    })
    if (refreshed?.metadata?.checkoutResult) {
      return refreshed.metadata.checkoutResult as CheckoutResult
    }
    if (refreshed) {
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
    ...(existing.checkoutUrl ? { checkoutUrl: existing.checkoutUrl } : {}),
  }
}

export async function handleConcurrentIdempotentCheckout(
  req: CheckoutRequest,
  paymentRepo: Pick<Repository<Payment>, 'findOne'>,
  inFlightCheckouts: InFlightCheckoutsMap,
  incomingFingerprint?: string,
  inFlightKey?: string,
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
    )
  }

  throw createIdempotencyConflictException()
}
