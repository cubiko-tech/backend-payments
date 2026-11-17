import { Logger } from '@nestjs/common'
import { Repository } from 'typeorm'
import { Payment, PaymentProvider } from '../payment/entities/payment.entity'
import { MercadoPagoNoticePayment } from '../provider/mercadopago/mercadopago.provider'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const logger = new Logger('MercadoPagoPaymentNotice')

export interface MercadoPagoNoticeClient {
  getNoticePayment(mpPaymentId: string): Promise<MercadoPagoNoticePayment>
}

export interface ResolvedMercadoPagoNotice {
  paymentId: string
  providerData: {
    mpPaymentId: string
    providerStatus: {
      status: string
      transactionAmount: number | null
    }
  }
}

/**
 * Resolves a Mercado Pago `payment.created` notification by querying the live payment status
 * (`GET /v1/payments/{id}`) and matching its `external_reference` to a Mercado Pago `Payment`.
 * Returns `null` when the notice should not complete any payment; throws when Mercado Pago fails.
 */
export async function resolveMercadoPagoNotice(
  client: MercadoPagoNoticeClient,
  paymentRepo: Pick<Repository<Payment>, 'findOne'>,
  mpPaymentId: string,
): Promise<ResolvedMercadoPagoNotice | null> {
  const notice = await client.getNoticePayment(mpPaymentId)

  if (notice.status !== 'approved') {
    logger.log(
      `MercadoPago notice ${mpPaymentId} ignored: status is "${notice.status}" (requires "approved")`,
    )
    return null
  }

  if (!notice.externalReference || !UUID_PATTERN.test(notice.externalReference)) {
    logger.warn(`MercadoPago notice ${mpPaymentId} ignored: missing or non-UUID external_reference`)
    return null
  }

  const payment = await paymentRepo.findOne({
    where: { id: notice.externalReference },
  })
  if (!payment) {
    logger.warn(
      `MercadoPago notice ${mpPaymentId} ignored: no payment found for external_reference ${notice.externalReference}`,
    )
    return null
  }

  if (payment.provider !== PaymentProvider.MERCADOPAGO) {
    logger.warn(
      `MercadoPago notice ${mpPaymentId} ignored: payment ${payment.id} belongs to provider "${payment.provider}"`,
    )
    return null
  }

  return {
    paymentId: payment.id,
    providerData: {
      mpPaymentId,
      providerStatus: {
        status: notice.status,
        transactionAmount: notice.transactionAmount,
      },
    },
  }
}
