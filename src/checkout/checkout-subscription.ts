import { EntityManager, In, Repository } from 'typeorm'

import { Payment } from '../payment/entities/payment.entity'
import {
  Subscription,
  SubscriptionStatus,
  SubscriptionProvider,
} from '../subscription/entities/subscription.entity'
import {
  PLAN_APPLYING_EVENTS,
  SubscriptionEvent,
  SubscriptionEventType,
} from '../subscription/entities/subscriptionEvent.entity'
import type { CheckoutRequest } from './checkout.service'
import { isLastPaymentNewer } from './wallet-payment-reconciliation'

export interface CheckoutSubscriptionDeps {
  subscriptionRepo: Repository<Subscription>
  subscriptionEventRepo: Repository<SubscriptionEvent>
  paymentRepo: Repository<Payment>
  billingPeriodDays: number
}

/**
 * Applies a paid plan purchase to the brand's subscription: creates it, extends the same active
 * plan, or changes plan, and records the event. A payment already applied returns as it was.
 */
export async function createOrRenewSubscription(
  req: CheckoutRequest,
  payment: Payment,
  deps: CheckoutSubscriptionDeps,
  manager?: EntityManager,
): Promise<{ subscription: Subscription; extended: boolean }> {
  const subscriptionRepo = manager?.getRepository(Subscription) ?? deps.subscriptionRepo
  const subscriptionEventRepo =
    manager?.getRepository(SubscriptionEvent) ?? deps.subscriptionEventRepo
  const now = new Date()
  const periodEnd = new Date()
  periodEnd.setDate(periodEnd.getDate() + deps.billingPeriodDays)

  let subscription = await subscriptionRepo.findOne({
    where: { brandId: req.brandId },
  })

  if (subscription) {
    if (payment?.id) {
      const existingEvent = await subscriptionEventRepo.findOne({
        where: { paymentId: payment.id, eventType: In(PLAN_APPLYING_EVENTS) },
      })
      if (subscription.lastPaymentId === payment.id || existingEvent) {
        return {
          subscription,
          extended: existingEvent?.metadata?.renewal === 'extended',
        }
      }
    }
    const fromPlan = subscription.planSlug
    const fromStatus = subscription.status
    const existingPeriodEnd =
      subscription.currentPeriodEnd instanceof Date
        ? subscription.currentPeriodEnd
        : subscription.currentPeriodEnd
          ? new Date(subscription.currentPeriodEnd)
          : null
    const isSameActivePlanExtension =
      fromStatus === SubscriptionStatus.ACTIVE &&
      !subscription.cancelledAt &&
      fromPlan === req.planSlug &&
      existingPeriodEnd !== null &&
      !Number.isNaN(existingPeriodEnd.getTime()) &&
      existingPeriodEnd.getTime() > now.getTime()

    const targetPeriodEnd = isSameActivePlanExtension
      ? new Date(existingPeriodEnd.getTime())
      : periodEnd
    if (isSameActivePlanExtension) {
      targetPeriodEnd.setDate(targetPeriodEnd.getDate() + deps.billingPeriodDays)
    }

    subscription.planSlug = req.planSlug
    subscription.status = SubscriptionStatus.ACTIVE
    subscription.provider = req.provider as SubscriptionProvider
    subscription.walletId = req.walletId || subscription.walletId
    subscription.currentPeriodStart = isSameActivePlanExtension
      ? subscription.currentPeriodStart || now
      : now
    subscription.currentPeriodEnd = targetPeriodEnd
    subscription.nextBillingDate = targetPeriodEnd
    // An older purchase of this plan extends it, but the newest purchase stays named:
    // the close of another plan decides its conflict by this payment's createdAt.
    const keepsNewerPayment =
      fromPlan === req.planSlug &&
      !!subscription.lastPaymentId &&
      (await isLastPaymentNewer(
        subscription.lastPaymentId,
        payment,
        manager?.getRepository(Payment) ?? deps.paymentRepo,
      ))
    if (!keepsNewerPayment) {
      subscription.lastPaymentId = payment.id
    }
    subscription.retryCount = 0
    subscription.cancelledAt = null
    subscription.cancelReason = null
    // Non-null `accessEndsAt` means a pending cancellation; clear it on renewal so `GET /subscription/current` does not report a stale cutoff.
    subscription.accessEndsAt = null
    subscription.autoRenew = true

    await subscriptionRepo.save(subscription)

    const eventType =
      fromPlan !== req.planSlug ? SubscriptionEventType.PLAN_CHANGED : SubscriptionEventType.RENEWED

    await subscriptionEventRepo.save(
      subscriptionEventRepo.create({
        subscriptionId: subscription.id,
        eventType,
        fromPlanSlug: fromPlan,
        toPlanSlug: req.planSlug,
        fromStatus,
        toStatus: SubscriptionStatus.ACTIVE,
        triggeredBy: req.userId,
        paymentId: payment.id,
        reason:
          eventType === SubscriptionEventType.PLAN_CHANGED
            ? `Cambio de plan ${fromPlan} → ${req.planSlug}`
            : 'Renovación por pago',
        ...(isSameActivePlanExtension
          ? {
              metadata: {
                renewal: 'extended',
                currentPeriodEnd: targetPeriodEnd.toISOString(),
              },
            }
          : {}),
      }),
    )

    return { subscription, extended: isSameActivePlanExtension }
  } else {
    subscription = subscriptionRepo.create({
      brandId: req.brandId,
      userId: req.userId,
      planSlug: req.planSlug,
      status: SubscriptionStatus.ACTIVE,
      provider: req.provider as SubscriptionProvider,
      walletId: req.walletId || null,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      nextBillingDate: periodEnd,
      lastPaymentId: payment.id,
      autoRenew: true,
    })
    await subscriptionRepo.save(subscription)

    await subscriptionEventRepo.save(
      subscriptionEventRepo.create({
        subscriptionId: subscription.id,
        eventType: SubscriptionEventType.CREATED,
        toPlanSlug: req.planSlug,
        toStatus: SubscriptionStatus.ACTIVE,
        triggeredBy: req.userId,
        paymentId: payment.id,
      }),
    )
  }

  return { subscription, extended: false }
}
