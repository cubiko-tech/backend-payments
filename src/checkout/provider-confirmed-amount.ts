import { HttpStatus } from '@nestjs/common'
import { DataSource, Repository } from 'typeorm'

import { Payment, PaymentStatus, PaymentProvider } from '../payment/entities/payment.entity'
import { RequestException } from '../shared/exception/request.exception'
import { logger as winstonLogger } from '../shared/logger/logger'
import { hasPaymentTakenEffect } from './external-payment-close'

export interface ProviderConfirmedAmountDeps {
  paymentRepo: Repository<Payment>
  dataSource: DataSource
  logger: { warn: (message: string) => void; error: (message: string) => void }
}

const providerConfirmedAmountSpecs: Record<
  string,
  | {
      verifiesAmount: false
      reason: 'provider_webhook_omits_confirmed_amount'
    }
  | {
      verifiesAmount: true
      unit: 'cents' | 'major'
      extractConfirmedAmount: (providerData: any) => unknown
    }
> = {
  [PaymentProvider.STRIPE]: {
    verifiesAmount: true,
    unit: 'cents',
    extractConfirmedAmount: (providerData: any) =>
      providerData?.amount ??
      providerData?.amount_total ??
      providerData?.amountTotal ??
      providerData?.data?.object?.amount ??
      providerData?.data?.object?.amount_total ??
      providerData?.providerStatus?.amountTotal,
  },
  [PaymentProvider.CONFIO]: {
    verifiesAmount: true,
    unit: 'cents',
    extractConfirmedAmount: (providerData: any) =>
      providerData?.data?.amountCents ??
      providerData?.amountCents ??
      providerData?.providerStatus?.amountCents,
  },
  [PaymentProvider.DROPI]: {
    verifiesAmount: true,
    unit: 'major',
    extractConfirmedAmount: (providerData: any) =>
      providerData?.amount ?? providerData?.data?.amount ?? providerData?.providerStatus?.amount,
  },
  // Its webhook omits the amount; only its status answer brings it.
  [PaymentProvider.MERCADOPAGO]: {
    verifiesAmount: true,
    unit: 'major',
    extractConfirmedAmount: (providerData: any) => providerData?.providerStatus?.transactionAmount,
  },
}

export function hasAmountMismatchMark(payment?: Payment | null): boolean {
  return Boolean(payment?.metadata && payment.metadata.amountMismatch)
}

async function markPaymentAmountMismatch(
  paymentRepo: Repository<Payment>,
  payment: Payment,
  providerData: any,
  mismatch: {
    code: 'PROVIDER_AMOUNT_MISMATCH'
    paymentId: string
    provider: string
    unit: 'cents' | 'major'
    expectedAmount: number
    confirmedAmount: number
    message: string
  },
): Promise<void> {
  const updatedMetadata = {
    ...(payment.metadata || {}),
    ...(providerData ? { providerData } : {}),
    amountMismatch: mismatch,
  }
  await paymentRepo.update(
    { id: payment.id, status: payment.status },
    {
      status: PaymentStatus.FAILED,
      failureReason: mismatch.message,
      metadata: updatedMetadata,
    },
  )
}

function toConfirmedAmountUnit(amountInMajorUnits: number, unit: 'cents' | 'major'): number {
  if (unit === 'cents') {
    return Math.round(Number(amountInMajorUnits) * 100)
  }
  return Math.round(Number(amountInMajorUnits) * 100) / 100
}

function normalizeConfirmedAmountInUnit(rawAmount: number, unit: 'cents' | 'major'): number {
  if (unit === 'cents') {
    return Math.round(rawAmount)
  }
  return Math.round(rawAmount * 100) / 100
}

export function isProviderNoticePayload(providerData?: any): boolean {
  if (!providerData || typeof providerData !== 'object') return false
  return typeof providerData.source !== 'string' || providerData.source.length === 0
}

/**
 * Compares the gross amount the provider confirmed with `payment.amount`. Returns false when a
 * notice omitted it (the payment goes back to its previous state); a mismatch marks the payment
 * failed and throws 409, unless the payment already took effect.
 */
export async function assertProviderConfirmedAmount(
  deps: ProviderConfirmedAmountDeps,
  payment: Payment,
  expectedAmount: number,
  providerData?: any,
  isNotice = false,
  previousStatus: PaymentStatus = PaymentStatus.PENDING,
  previousMetadata?: Payment['metadata'],
): Promise<boolean> {
  const providerKey = String(payment.provider || '').toLowerCase()
  const spec = providerConfirmedAmountSpecs[providerKey]
  if (!spec || !spec.verifiesAmount) {
    return true
  }
  const rawCandidate =
    (providerData && typeof providerData === 'object'
      ? spec.extractConfirmedAmount(providerData)
      : undefined) ??
    (payment.metadata?.providerData && typeof payment.metadata.providerData === 'object'
      ? spec.extractConfirmedAmount(payment.metadata.providerData)
      : undefined)
  if (
    rawCandidate === undefined ||
    rawCandidate === null ||
    rawCandidate === '' ||
    !Number.isFinite(Number(rawCandidate))
  ) {
    if (!isNotice) {
      return true
    }
    deps.logger.warn(
      `Provider ${providerKey} notice for payment ${payment.id} omitted confirmed amount; deferring to reconciliation`,
    )
    await deps.paymentRepo.update(
      { id: payment.id, status: PaymentStatus.PROCESSING },
      { status: previousStatus, metadata: previousMetadata },
    )
    payment.status = previousStatus
    payment.metadata = previousMetadata
    return false
  }
  const numericConfirmed = Number(rawCandidate)
  const expectedInUnit = toConfirmedAmountUnit(expectedAmount, spec.unit)
  const confirmedInUnit = normalizeConfirmedAmountInUnit(numericConfirmed, spec.unit)
  if (expectedInUnit !== confirmedInUnit) {
    const message =
      `Provider confirmed gross amount (${confirmedInUnit} ${spec.unit}) does not match ` +
      `payment.amount (${expectedInUnit} ${spec.unit}) for payment ${payment.id}`
    const mismatch = {
      code: 'PROVIDER_AMOUNT_MISMATCH' as const,
      paymentId: payment.id,
      provider: providerKey,
      unit: spec.unit,
      expectedAmount: expectedInUnit,
      confirmedAmount: confirmedInUnit,
      message,
    }
    deps.logger.error(message)
    winstonLogger.log('error', message, mismatch)
    // What was given stays given: `failed` would leave it in place with nothing to revert it.
    if (await hasPaymentTakenEffect(payment.id, deps.dataSource)) return true
    await markPaymentAmountMismatch(deps.paymentRepo, payment, providerData, mismatch)
    throw new RequestException(
      {
        code: 'PROVIDER_AMOUNT_MISMATCH',
        paymentId: payment.id,
        message,
      },
      HttpStatus.CONFLICT,
    )
  }
  return true
}
