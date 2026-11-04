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
import { WebhookEvent } from '../webhook/entities/webhookEvent.entity'
import {
  expirePendingCheckouts,
  reconcileExternalPayments,
  reconcileWalletBalances,
  reconcileWalletPayments,
  retryMissingCreditNotes,
  settleLostExternalPayments,
} from './payment-sweep'
import { confirmarAltasPendientes, franjasDeRepesca } from './pending-signup-confirmation'
import { refundOrphanRenewalDebits } from './renewal-debit-refund'
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
} from './subscription-renewal'

export { franjasDeRepesca }

/**
 * Scheduled `@Cron` entrypoints of `backend-payments`. Each domain responsibility lives in its own
 * module under `src/tasks/`.
 */
@Injectable()
export class TasksService {
  private readonly MAX_RETRY = parseInt(process.env.MAX_PAYMENT_RETRY_COUNT || '3')
  private readonly MAX_REPESCA = parseInt(process.env.MAX_PENDING_CONFIRMATIONS || '50')
  private readonly DIAS_DE_REPESCA = parseInt(process.env.PENDING_CONFIRMATION_DAYS || '8')
  private repescaEnCurso = false
  private readonly CHECKOUT_EXPIRY_HOURS = checkoutExpiryHours()
  private readonly BILLING_PERIOD_DAYS = parseInt(process.env.BILLING_PERIOD_DAYS || '30')
  private readonly RENEWAL_POSTPONEMENT_GRACE_HOURS = 24
  private readonly subscriptionLocks = new Map<string, Promise<void>>()

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
    private checkoutService: CheckoutService,
    private confioWebhook: ConfioSubscriptionWebhookService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async processTrialConversions() {
    await processTrialConversions(this as any)
  }

  @Cron('*/5 * * * *')
  async confirmarAltasPendientes() {
    await confirmarAltasPendientes(this as any)
  }

  @Cron(CronExpression.EVERY_HOUR)
  async processSubscriptionRenewals() {
    await processSubscriptionRenewals(this as any)
  }

  @Cron('0 */6 * * *')
  async retryFailedPayments() {
    await retryFailedPayments(this as any)
  }

  @Cron(CronExpression.EVERY_HOUR)
  async refundOrphanRenewalDebits() {
    await refundOrphanRenewalDebits(this as any)
  }

  @Cron('*/5 * * * *')
  async reconcileExternalPayments() {
    await reconcileExternalPayments(this as any)
  }

  @Cron('*/5 * * * *')
  async settleLostExternalPayments() {
    await settleLostExternalPayments(this as any)
  }

  @Cron('*/5 * * * *')
  async retryMissingCreditNotes() {
    await retryMissingCreditNotes(this as any)
  }

  @Cron('*/5 * * * *')
  async reconcileWalletPayments() {
    await reconcileWalletPayments(this as any)
  }

  @Cron('*/30 * * * *')
  async expirePendingCheckouts() {
    await expirePendingCheckouts(this as any)
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expireSubscriptions() {
    await expireSubscriptions(this as any)
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expireCancelledSubscriptions() {
    await expireCancelledSubscriptions(this as any)
  }

  @Cron('0 2 * * *')
  async reconcileWalletBalances() {
    await reconcileWalletBalances(this as any)
  }

  @Cron('0 8 * * *')
  async processDropiBatchCharges() {
    await processDropiBatchCharges(this as any)
  }

  @Cron('0 3 * * 0')
  async cleanupExpiredWebhooks() {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 90)

    const result = await this.webhookEventRepo.delete({
      status: 'processed' as any,
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
    await sendExpirationWarnings(this as any)
  }
}
