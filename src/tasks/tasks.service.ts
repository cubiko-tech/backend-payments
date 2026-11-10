import { Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm'
import { DataSource, LessThan, Repository } from 'typeorm'

import { AuditService } from '../audit/audit.service'
import { checkoutExpiryHours } from '../checkout/checkout-expiry'
import { CheckoutService } from '../checkout/checkout.service'
import { ClientRolesService } from '../client/client-roles.service'
import { EventBusService } from '../event-bus/event-bus.service'
import { Payment } from '../payment/entities/payment.entity'
import { ProviderFactory } from '../provider/provider.factory'
import { logger } from '../shared/logger/logger'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { Wallet } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { WalletService } from '../wallet/wallet.service'
import { ConfioSubscriptionWebhookService } from '../webhook/confio-subscription-webhook.service'
import { WebhookEvent, WebhookStatus } from '../webhook/entities/webhookEvent.entity'
import {
  expirePendingCheckouts,
  PaymentSweepDeps,
  reconcileExternalPayments,
  reconcileWalletBalances,
  reconcileWalletPayments,
  retryMissingCreditNotes,
  settleLostExternalPayments,
} from './payment-sweep'
import {
  confirmarAltasPendientes,
  franjasDeRepesca,
  PendingSignupConfirmationDeps,
} from './pending-signup-confirmation'
import { OrphanRenewalSweepDeps, refundOrphanRenewalDebits } from './renewal-debit-refund'
import {
  expireCancelledSubscriptions,
  expireSubscriptions,
  sendExpirationWarnings,
} from './subscription-expiration'
import {
  processDropiBatchCharges,
  processSubscriptionRenewals,
  processTrialConversions,
  retryFailedPayments,
  SubscriptionRenewalDeps,
} from './subscription-renewal'

export { franjasDeRepesca }

/** Everything the cron modules read from the service; each cron receives the service itself. */
export type TasksDeps = PaymentSweepDeps &
  PendingSignupConfirmationDeps &
  OrphanRenewalSweepDeps &
  SubscriptionRenewalDeps

/**
 * Scheduled `@Cron` entrypoints of `backend-payments`. Each domain responsibility lives in its own
 * module under `src/tasks/`.
 */
@Injectable()
export class TasksService implements TasksDeps {
  readonly MAX_RETRY = parseInt(process.env.MAX_PAYMENT_RETRY_COUNT || '3')
  readonly MAX_REPESCA = parseInt(process.env.MAX_PENDING_CONFIRMATIONS || '50')
  readonly DIAS_DE_REPESCA = parseInt(process.env.PENDING_CONFIRMATION_DAYS || '8')
  repescaEnCurso = false
  readonly CHECKOUT_EXPIRY_HOURS = checkoutExpiryHours()
  readonly BILLING_PERIOD_DAYS = parseInt(process.env.BILLING_PERIOD_DAYS || '30')
  readonly RENEWAL_POSTPONEMENT_GRACE_HOURS = 24
  readonly subscriptionLocks = new Map<string, Promise<void>>()

  constructor(
    @InjectRepository(Wallet, 'DBRead')
    readonly walletReadRepo: Repository<Wallet>,
    @InjectRepository(WalletBalanceSnapshot, 'DBWrite')
    readonly snapshotRepo: Repository<WalletBalanceSnapshot>,
    @InjectRepository(Transaction, 'DBRead')
    readonly transactionReadRepo: Repository<Transaction>,
    @InjectRepository(Payment, 'DBWrite')
    readonly paymentRepo: Repository<Payment>,
    @InjectRepository(Subscription, 'DBWrite')
    readonly subscriptionRepo: Repository<Subscription>,
    @InjectRepository(SubscriptionEvent, 'DBWrite')
    readonly subscriptionEventRepo: Repository<SubscriptionEvent>,
    @InjectRepository(WebhookEvent, 'DBWrite')
    private webhookEventRepo: Repository<WebhookEvent>,
    @InjectDataSource('DBWrite')
    readonly dataSource: DataSource,
    readonly walletService: WalletService,
    readonly auditService: AuditService,
    readonly providerFactory: ProviderFactory,
    readonly eventBus: EventBusService,
    readonly clientRoles: ClientRolesService,
    readonly checkoutService: CheckoutService,
    readonly confioWebhook: ConfioSubscriptionWebhookService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async processTrialConversions() {
    await processTrialConversions(this)
  }

  @Cron('*/5 * * * *')
  async confirmarAltasPendientes() {
    await confirmarAltasPendientes(this)
  }

  @Cron(CronExpression.EVERY_HOUR)
  async processSubscriptionRenewals() {
    await processSubscriptionRenewals(this)
  }

  @Cron('0 */6 * * *')
  async retryFailedPayments() {
    await retryFailedPayments(this)
  }

  @Cron(CronExpression.EVERY_HOUR)
  async refundOrphanRenewalDebits() {
    await refundOrphanRenewalDebits(this)
  }

  @Cron('*/5 * * * *')
  async reconcileExternalPayments() {
    await reconcileExternalPayments(this)
  }

  @Cron('*/5 * * * *')
  async settleLostExternalPayments() {
    await settleLostExternalPayments(this)
  }

  @Cron('*/5 * * * *')
  async retryMissingCreditNotes() {
    await retryMissingCreditNotes(this)
  }

  @Cron('*/5 * * * *')
  async reconcileWalletPayments() {
    await reconcileWalletPayments(this)
  }

  @Cron('*/30 * * * *')
  async expirePendingCheckouts() {
    await expirePendingCheckouts(this)
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expireSubscriptions() {
    await expireSubscriptions(this)
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expireCancelledSubscriptions() {
    await expireCancelledSubscriptions(this)
  }

  @Cron('0 2 * * *')
  async reconcileWalletBalances() {
    await reconcileWalletBalances(this)
  }

  @Cron('0 8 * * *')
  async processDropiBatchCharges() {
    await processDropiBatchCharges(this)
  }

  @Cron('0 3 * * 0')
  async cleanupExpiredWebhooks() {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 90)

    const result = await this.webhookEventRepo.delete({
      status: WebhookStatus.PROCESSED,
      createdAt: LessThan(cutoff),
    })

    if (result.affected > 0) {
      logger.log('info', `[CRON] cleanupExpiredWebhooks: ${result.affected} webhooks archivados`)
    }
  }

  @Cron('0 1 * * *')
  async generatePendingInvoices() {
    logger.log('info', '[CRON] generatePendingInvoices: (pendiente de implementación)')
  }

  @Cron('0 9 * * *')
  async sendExpirationWarnings() {
    await sendExpirationWarnings(this)
  }
}
