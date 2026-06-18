import { Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, LessThan, In, Between, Repository } from 'typeorm'

import { Wallet } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { Subscription, SubscriptionStatus } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'
import { WebhookEvent } from '../webhook/entities/webhookEvent.entity'
import { WalletService } from '../wallet/wallet.service'
import { AuditService } from '../audit/audit.service'
import { ProviderFactory } from '../provider/provider.factory'
import { EventBusService } from '../event-bus/event-bus.service'
import { ClientRolesService } from '../client/client-roles.service'
import { logger } from '../shared/logger/logger'

@Injectable()
export class TasksService {
  private readonly MAX_RETRY = parseInt(process.env.MAX_PAYMENT_RETRY_COUNT || '3')
  private readonly CHECKOUT_EXPIRY_HOURS = parseInt(process.env.CHECKOUT_EXPIRY_HOURS || '24')

  constructor(
    @InjectRepository(Wallet, 'DBRead')
    private walletReadRepo: Repository<Wallet>,
    @InjectRepository(WalletBalanceSnapshot, 'DBWrite')
    private snapshotRepo: Repository<WalletBalanceSnapshot>,
    @InjectRepository(Transaction, 'DBRead')
    private transactionReadRepo: Repository<Transaction>,
    @InjectRepository(Payment, 'DBWrite')
    private paymentRepo: Repository<Payment>,
    @InjectRepository(Subscription, 'DBWrite')
    private subscriptionRepo: Repository<Subscription>,
    @InjectRepository(SubscriptionEvent, 'DBWrite')
    private subscriptionEventRepo: Repository<SubscriptionEvent>,
    @InjectRepository(WebhookEvent, 'DBWrite')
    private webhookEventRepo: Repository<WebhookEvent>,
    @InjectDataSource('DBWrite')
    private dataSource: DataSource,
    private walletService: WalletService,
    private auditService: AuditService,
    private providerFactory: ProviderFactory,
    private eventBus: EventBusService,
    private clientRoles: ClientRolesService,
  ) {}

  // =============================================================
  // 1. Renovar suscripciones (cada hora)
  // =============================================================
  @Cron(CronExpression.EVERY_HOUR)
  async processSubscriptionRenewals() {
    const now = new Date()
    logger.log('info', '[CRON] processSubscriptionRenewals: iniciando')

    const dueSubscriptions = await this.subscriptionRepo.find({
      where: {
        status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE]),
        autoRenew: true,
        nextBillingDate: LessThan(now),
      },
    })

    let processed = 0
    for (const sub of dueSubscriptions) {
      try {
        if (sub.provider === 'wallet' && sub.walletId) {
          await this.renewFromWallet(sub)
          processed++
        }
        // Stripe/MP manejan renovación automática via webhooks
        // Dropi se maneja en processDropiBatchCharges
      } catch (error) {
        logger.log('error', `[CRON] Error renovando suscripción ${sub.id}: ${error.message}`)
        await this.handleRenewalFailure(sub)
      }
    }

    if (processed > 0 || dueSubscriptions.length > 0) {
      logger.log('info', `[CRON] processSubscriptionRenewals: ${processed}/${dueSubscriptions.length} procesadas`)
    }
  }

  // =============================================================
  // 2. Reintentar pagos fallidos (cada 6 horas)
  // =============================================================
  @Cron('0 */6 * * *')
  async retryFailedPayments() {
    logger.log('info', '[CRON] retryFailedPayments: iniciando')

    const retryableSubscriptions = await this.subscriptionRepo.find({
      where: {
        status: SubscriptionStatus.PAST_DUE,
        autoRenew: true,
      },
    })

    let retried = 0
    for (const sub of retryableSubscriptions) {
      if (sub.retryCount >= this.MAX_RETRY) continue

      // Backoff exponencial: 24h, 48h, 72h
      const hoursToWait = (sub.retryCount + 1) * 24
      const lastAttempt = sub.updatedAt || sub.createdAt
      const nextRetry = new Date(lastAttempt.getTime() + hoursToWait * 60 * 60 * 1000)

      if (new Date() < nextRetry) continue

      try {
        if (sub.provider === 'wallet' && sub.walletId) {
          await this.renewFromWallet(sub)
          retried++
        }
      } catch (error) {
        logger.log('error', `[CRON] Reintento fallido para suscripción ${sub.id}: ${error.message}`)
        await this.handleRenewalFailure(sub)
      }
    }

    if (retried > 0) {
      logger.log('info', `[CRON] retryFailedPayments: ${retried} reintentados`)
    }
  }

  // =============================================================
  // 3. Expirar checkouts pendientes (cada 30 min)
  // =============================================================
  @Cron('*/30 * * * *')
  async expirePendingCheckouts() {
    const expiryTime = new Date()
    expiryTime.setHours(expiryTime.getHours() - this.CHECKOUT_EXPIRY_HOURS)

    const result = await this.paymentRepo.update(
      {
        status: PaymentStatus.PENDING,
        createdAt: LessThan(expiryTime),
      },
      {
        status: PaymentStatus.FAILED,
        failureReason: 'Checkout expirado por inactividad',
      },
    )

    if (result.affected > 0) {
      logger.log('info', `[CRON] expirePendingCheckouts: ${result.affected} checkouts expirados`)
    }
  }

  // =============================================================
  // 4. Expirar suscripciones con reintentos agotados (cada hora)
  // =============================================================
  @Cron(CronExpression.EVERY_HOUR)
  async expireSubscriptions() {
    const expired = await this.subscriptionRepo.find({
      where: {
        status: SubscriptionStatus.PAST_DUE,
      },
    })

    let count = 0
    for (const sub of expired) {
      if (sub.retryCount < this.MAX_RETRY) continue

      const previousStatus = sub.status
      sub.status = SubscriptionStatus.EXPIRED
      await this.subscriptionRepo.save(sub)

      await this.subscriptionEventRepo.save(
        this.subscriptionEventRepo.create({
          subscriptionId: sub.id,
          eventType: SubscriptionEventType.EXPIRED,
          fromStatus: previousStatus,
          toStatus: SubscriptionStatus.EXPIRED,
          triggeredBy: 'system',
          reason: `Reintentos de pago agotados (${this.MAX_RETRY} intentos)`,
        }),
      )

      // Remover plan de la marca en backend-roles (HTTP directo)
      await this.clientRoles.removePlanFromBrand(sub.brandId, sub.planSlug)

      // Publicar evento para redundancia (backend-roles consumer) y notificaciones
      this.eventBus.publishSubscriptionExpired({
        brandId: sub.brandId,
        subscriptionId: sub.id,
        planSlug: sub.planSlug,
      })

      logger.log('info', `[CRON] Suscripción expirada: brandId=${sub.brandId}`)
      count++
    }

    if (count > 0) {
      logger.log('info', `[CRON] expireSubscriptions: ${count} suscripciones expiradas`)
    }
  }

  // =============================================================
  // 5. Reconciliar saldos de wallets (diario 2am)
  // =============================================================
  @Cron('0 2 * * *')
  async reconcileWalletBalances() {
    logger.log('info', '[CRON] reconcileWalletBalances: iniciando')

    const wallets = await this.walletReadRepo.find({
      where: { status: 'active' as any },
    })

    let inconsistent = 0
    const now = new Date()

    for (const wallet of wallets) {
      // Sumar todas las transacciones completadas
      const result = await this.dataSource.query(`
        SELECT
          COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0) -
          COALESCE(SUM(CASE WHEN type = 'debit' THEN amount ELSE 0 END), 0) AS calculated,
          COUNT(*) AS count
        FROM transactions
        WHERE "walletId" = $1 AND status = 'completed'
      `, [wallet.id])

      const calculatedBalance = parseFloat(result[0]?.calculated || '0')
      const transactionCount = parseInt(result[0]?.count || '0')
      const currentBalance = parseFloat(String(wallet.balance))
      const isConsistent = Math.abs(currentBalance - calculatedBalance) < 0.01

      await this.snapshotRepo.save(
        this.snapshotRepo.create({
          walletId: wallet.id,
          balance: currentBalance,
          calculatedBalance,
          transactionCount,
          isConsistent,
          snapshotAt: now,
        }),
      )

      if (!isConsistent) {
        inconsistent++
        logger.log('error',
          `[CRON] DESCUADRE en wallet ${wallet.id}: balance=${currentBalance}, calculado=${calculatedBalance}, diff=${currentBalance - calculatedBalance}`,
        )
      }
    }

    logger.log('info',
      `[CRON] reconcileWalletBalances: ${wallets.length} wallets verificadas, ${inconsistent} inconsistentes`,
    )
  }

  // =============================================================
  // 6. Enviar cobros masivos a Dropi (diario 8am)
  // =============================================================
  @Cron('0 8 * * *')
  async processDropiBatchCharges() {
    logger.log('info', '[CRON] processDropiBatchCharges: iniciando')

    const dropiSubscriptions = await this.subscriptionRepo.find({
      where: {
        status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE]),
        provider: 'dropi' as any,
        autoRenew: true,
        nextBillingDate: LessThan(new Date()),
      },
    })

    if (dropiSubscriptions.length === 0) return

    try {
      const dropiProvider = this.providerFactory.getDropiProvider()
      const allPrices = await this.clientRoles.getAllPlanPrices()

      const charges = dropiSubscriptions.map((sub) => ({
        userId: sub.userId,
        brandId: sub.brandId,
        amount: allPrices.get(sub.planSlug)?.get('COP') || 0,
        currency: 'COP',
        description: `Suscripción plan ${sub.planSlug}`,
        referenceId: sub.id,
      })).filter((c) => c.amount > 0)

      if (charges.length > 0) {
        await dropiProvider.batchCharge(charges)
        logger.log('info', `[CRON] processDropiBatchCharges: ${charges.length} cobros enviados a Dropi`)
      }
    } catch (error) {
      logger.log('error', `[CRON] processDropiBatchCharges: error enviando cobros a Dropi: ${error.message}`)
    }
  }

  // =============================================================
  // 7. Limpiar webhooks antiguos (semanal, domingo 3am)
  // =============================================================
  @Cron('0 3 * * 0')
  async cleanupExpiredWebhooks() {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 90) // 90 días

    const result = await this.webhookEventRepo.delete({
      status: 'processed' as any,
      createdAt: LessThan(cutoff),
    })

    if (result.affected > 0) {
      logger.log('info', `[CRON] cleanupExpiredWebhooks: ${result.affected} webhooks archivados`)
    }
  }

  // =============================================================
  // 8. Generar facturas pendientes (diario 1am)
  // =============================================================
  @Cron('0 1 * * *')
  async generatePendingInvoices() {
    // TODO: Implementar generación de facturas para pagos completados sin factura
    logger.log('info', '[CRON] generatePendingInvoices: (pendiente de implementación)')
  }

  // =============================================================
  // 9. Alertas de expiración de suscripción (diario 9am)
  // =============================================================
  @Cron('0 9 * * *')
  async sendExpirationWarnings() {
    const now = new Date()

    // Avisos en 7, 3, 1, 0 días antes de expiración
    const warningDays = [7, 3, 1, 0]

    for (const days of warningDays) {
      const targetDate = new Date(now)
      targetDate.setDate(targetDate.getDate() + days)

      // Buscar suscripciones cuyo currentPeriodEnd sea hoy + N días (±12h margen)
      const rangeStart = new Date(targetDate)
      rangeStart.setHours(0, 0, 0, 0)
      const rangeEnd = new Date(targetDate)
      rangeEnd.setHours(23, 59, 59, 999)

      const subscriptions = await this.subscriptionRepo.find({
        where: {
          status: In([SubscriptionStatus.ACTIVE]),
          autoRenew: false, // Solo avisar a los que NO auto-renuevan
          currentPeriodEnd: Between(rangeStart, rangeEnd),
        },
      })

      for (const sub of subscriptions) {
        if (days === 0) {
          await this.eventBus.notifySubscriptionExpired(sub.brandId, sub.planSlug)
        } else {
          await this.eventBus.notifySubscriptionExpiring(sub.brandId, sub.planSlug, String(days))
        }
      }

      if (subscriptions.length > 0) {
        logger.log('info', `[CRON] sendExpirationWarnings: ${subscriptions.length} avisos enviados (${days} días)`)
      }
    }
  }

  // =============================================================
  // 10. Dunning: notificar en cada reintento fallido (integrado en retryFailedPayments)
  // Las notificaciones de dunning se disparan dentro de handleRenewalFailure()
  // =============================================================

  // =============================================================
  // Helpers
  // =============================================================

  /**
   * Renovar suscripción cobrando de wallet interna.
   */
  private async renewFromWallet(sub: Subscription) {
    const amount = await this.clientRoles.getPlanPrice(sub.planSlug, 'COP') || 0

    if (amount === 0) {
      // Plan gratuito, solo renovar periodo
      await this.extendSubscriptionPeriod(sub)
      return
    }

    // Debitar wallet
    await this.walletService.debit(sub.walletId, amount, {
      brandId: sub.brandId,
      category: 'plan_payment',
      description: `Renovación plan ${sub.planSlug}`,
      referenceType: 'subscription',
      referenceId: sub.id,
    })

    // Renovar periodo
    await this.extendSubscriptionPeriod(sub)

    // Registrar evento
    await this.subscriptionEventRepo.save(
      this.subscriptionEventRepo.create({
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.RENEWED,
        toPlanSlug: sub.planSlug,
        fromStatus: sub.status,
        toStatus: SubscriptionStatus.ACTIVE,
        triggeredBy: 'system',
        reason: 'Renovación automática desde wallet',
      }),
    )

    // Publicar evento de renovación
    this.eventBus.publishSubscriptionRenewed({
      brandId: sub.brandId,
      subscriptionId: sub.id,
      planSlug: sub.planSlug,
    })
  }

  /**
   * Extender periodo de la suscripción 30 días.
   */
  private async extendSubscriptionPeriod(sub: Subscription) {
    const newPeriodStart = new Date()
    const newPeriodEnd = new Date()
    newPeriodEnd.setDate(newPeriodEnd.getDate() + 30)

    sub.currentPeriodStart = newPeriodStart
    sub.currentPeriodEnd = newPeriodEnd
    sub.nextBillingDate = newPeriodEnd
    sub.status = SubscriptionStatus.ACTIVE
    sub.retryCount = 0

    await this.subscriptionRepo.save(sub)

    // Renovar expiresAt del plan en backend-roles
    await this.clientRoles.renewPlanForBrand(sub.brandId, sub.planSlug, newPeriodEnd)
  }

  /**
   * Manejar fallo de renovación: incrementar retry, marcar past_due.
   */
  private async handleRenewalFailure(sub: Subscription) {
    sub.retryCount = (sub.retryCount || 0) + 1
    sub.status = SubscriptionStatus.PAST_DUE
    await this.subscriptionRepo.save(sub)

    await this.subscriptionEventRepo.save(
      this.subscriptionEventRepo.create({
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.PAYMENT_FAILED,
        fromStatus: sub.status,
        toStatus: SubscriptionStatus.PAST_DUE,
        triggeredBy: 'system',
        reason: `Intento de pago fallido (${sub.retryCount}/${this.MAX_RETRY})`,
      }),
    )

    // Dunning: notificar al usuario según el intento
    const dunningMessages: Record<number, string> = {
      1: 'Tu pago falló. Verifica tu método de pago.',
      2: 'Segundo intento de pago fallido. Actualiza tu método de pago para no perder tu plan.',
      3: 'Último intento de pago. Si no se resuelve, tu plan será desactivado.',
    }

    const message = dunningMessages[sub.retryCount] || 'Tu pago no pudo ser procesado.'

    await this.eventBus.notifyPaymentFailed(sub.brandId, sub.id, message)
    logger.log('info', `[DUNNING] Notificación enviada a marca ${sub.brandId}: intento ${sub.retryCount}/${this.MAX_RETRY}`)
  }
}
