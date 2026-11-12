import { Between, IsNull, Not, Repository } from 'typeorm'

import { logger } from '../shared/logger/logger'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
} from '../subscription/entities/subscription.entity'
import { ConfioSubscriptionWebhookService } from '../webhook/confio-subscription-webhook.service'

const CATCHUP_TIERS = [
  { upToMinutes: 60, everyMinutes: 5 },
  { upToMinutes: 24 * 60, everyMinutes: 30 },
  { upToMinutes: Infinity, everyMinutes: 360 },
]

const CRON_PERIOD_MINUTES = 5

/**
 * Age windows to query in the current 5-minute pass, returned as absolute date ranges for
 * `Between`. The first tier runs on every pass; older tiers run when the minute of the day aligns
 * with their cadence, capped at `ventanaMinutos`.
 */
export function franjasDeRepesca(
  ahora: Date,
  ventanaMinutos: number,
): { desde: Date; hasta: Date }[] {
  const minutoDelDia = ahora.getHours() * 60 + ahora.getMinutes()
  const ms = (minutos: number) => new Date(ahora.getTime() - minutos * 60 * 1000)

  const franjas: { desde: Date; hasta: Date }[] = []
  let desdeMinutos = 0
  for (const tramo of CATCHUP_TIERS) {
    const hastaMinutos = Math.min(tramo.upToMinutes, ventanaMinutos)
    if (desdeMinutos >= hastaMinutos) break

    if (minutoDelDia % tramo.everyMinutes < CRON_PERIOD_MINUTES) {
      franjas.push({ desde: ms(hastaMinutos), hasta: ms(desdeMinutos) })
    }
    desdeMinutos = tramo.upToMinutes
  }

  return franjas
}

export interface PendingSignupConfirmationDeps {
  subscriptionRepo: Repository<Subscription>
  confioWebhook: ConfioSubscriptionWebhookService
  MAX_REPESCA: number
  DIAS_DE_REPESCA: number
  repescaEnCurso: boolean
}

/**
 * Polls ConfioPagos for `pending` signups within the catch-up window and applies the same
 * grant/close rules as the webhook, without ever issuing a new payment link.
 */
export async function confirmarAltasPendientes(deps: PendingSignupConfirmationDeps): Promise<void> {
  if (deps.repescaEnCurso) {
    logger.log(
      'info',
      '[CRON] confirmarAltasPendientes: la pasada anterior sigue en curso, se saltea',
    )
    return
  }
  deps.repescaEnCurso = true

  try {
    const tramos = franjasDeRepesca(new Date(), deps.DIAS_DE_REPESCA * 24 * 60)
    if (tramos.length === 0) return

    const pendientes = await deps.subscriptionRepo.find({
      where: tramos.map((franja) => ({
        status: SubscriptionStatus.PENDING,
        provider: SubscriptionProvider.CONFIO,
        providerSubscriptionId: Not(IsNull()),
        initialPaymentLinkIssuedAt: Between(franja.desde, franja.hasta),
      })),
      order: { updatedAt: 'ASC' },
      take: deps.MAX_REPESCA,
    })

    if (pendientes.length === 0) return

    let otorgadas = 0
    let cerradas = 0
    let sinConfirmar = 0
    let fallidas = 0
    for (const sub of pendientes) {
      try {
        const { resultado } = await deps.confioWebhook.confirmarContraElProveedor(sub)
        if (resultado === 'otorgada') otorgadas++
        else if (resultado === 'cerrada') cerradas++
        else if (resultado === 'sin_confirmar') sinConfirmar++
      } catch (error) {
        fallidas++
        logger.log('error', `[CRON] confirmarAltasPendientes: ${sub.id} falló: ${error?.message}`)
      }
    }

    logger.log(
      'info',
      `[CRON] confirmarAltasPendientes: ${pendientes.length} revisadas, ${otorgadas} otorgadas, ` +
        `${cerradas} cerradas por el proveedor, ${sinConfirmar} todavía sin aceptar, ` +
        `${fallidas} con error`,
    )
  } finally {
    deps.repescaEnCurso = false
  }
}
