import { Injectable, Logger } from '@nestjs/common'
import { EntityManager } from 'typeorm'

import { AuditService } from '../audit/audit.service'
import { ClientRolesService } from '../client/client-roles.service'
import { ConfioWebhookPayload } from '../provider/confio/confio.types'
import { Subscription } from '../subscription/entities/subscription.entity'
import { SubscriptionEvent } from '../subscription/entities/subscriptionEvent.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity'
import { TokenOrigin } from '../wallet/token-origin'
import { TokenWalletService } from '../wallet/token-wallet.service'
import { subscriptionBonusKey } from './subscription-bonus-key'
import { subscriptionBonusLimits } from './subscription-bonus-limits'
import { bonusRefusal } from './subscription-bonus-rule'

/** Author of every cycle bonus in `audit_log`: no person gives it. */
export const SUBSCRIPTION_BONUS_AUTHOR = 'system:confio-subscription'

/** `transactions.referenceType` of a cycle bonus; the monthly cap sums these rows. */
export const SUBSCRIPTION_BONUS_REFERENCE = 'subscription_bonus'

/** Closed list of reasons a subscription gives gift tokens for. */
export enum SubscriptionBonusReason {
  SUBSCRIPTION_CYCLE = 'subscription_cycle',
}

/** A bonus decided before the transaction: what to credit, to which wallet, under which key. */
export interface PlannedBonus {
  key: string
  tokens: number
  /** The brand's token wallet, never `subscriptions.walletId` (the payment wallet). */
  walletId: string
  brandId: string
  planSlug: string
  subscriptionId: string
  providerSubscriptionId: string
  cycleNumber: number
  /** Signed checksum of the notice; every re-split of it keeps this value. */
  checksum: string
}

/**
 * The token bonus a paid subscription cycle gives the brand: the plan's `tokensPerCycle`, as `gift`,
 * once per cycle. `plan` runs before the webhook's transaction (it calls backend-roles); `credit`
 * runs inside it, so the bonus commits or rolls back with the charge's effect.
 */
@Injectable()
export class SubscriptionBonusService {
  private readonly logger = new Logger(SubscriptionBonusService.name)

  constructor(
    private readonly tokenWallets: TokenWalletService,
    private readonly audit: AuditService,
    private readonly roles: ClientRolesService,
  ) {}

  /**
   * The bonus of this paid notice, or `null` when it gives none. The brand and plan come from the
   * stored subscription, never from the notice. Throws when the plan catalog is unavailable.
   */
  async plan(payload: ConfioWebhookPayload, sub: Subscription): Promise<PlannedBonus | null> {
    const key = subscriptionBonusKey(payload, sub)
    const checksum = payload?.signature?.checksum
    if (!key || typeof checksum !== 'string' || checksum.length === 0) {
      this.logger.warn(
        `Cycle bonus skipped for ${sub.id}: no signed subscription, cycle and checksum`,
      )
      return null
    }
    if (!sub.brandId || !sub.planSlug) {
      this.logger.warn(`Cycle bonus skipped for ${sub.id}: subscription without brand or plan`)
      return null
    }

    // Before creating the wallet: a plan without bonus must not open one.
    const tokens = await this.roles.getTokensPerCycle(sub.planSlug)
    if (tokens <= 0) {
      this.logger.log(`Cycle bonus skipped for ${sub.id}: plan ${sub.planSlug} gives no tokens`)
      return null
    }

    const wallet = await this.tokenWallets.getOrCreate(sub.brandId, sub.userId)
    return {
      key,
      tokens,
      walletId: wallet.id,
      brandId: sub.brandId,
      planSlug: sub.planSlug,
      subscriptionId: sub.id,
      providerSubscriptionId: sub.providerSubscriptionId,
      cycleNumber: payload.data.cycleNumber,
      checksum,
    }
  }

  /**
   * Credits `bonus` inside the caller's transaction. `locked` is the subscription row the caller
   * holds under `pessimistic_write`, which serializes every bonus of that row. Any refusal of
   * `bonusRefusal` or a cap reached credits nothing and returns; a database failure throws and
   * rolls all back.
   */
  async credit(manager: EntityManager, bonus: PlannedBonus, locked: Subscription): Promise<void> {
    const wallet = await manager.findOne(Wallet, {
      where: { id: bonus.walletId },
      lock: { mode: 'pessimistic_write' },
    })
    const refusal = bonusRefusal({
      planned: bonus,
      locked,
      wallet: wallet && { brandId: wallet.brandId, closed: wallet.status === WalletStatus.CLOSED },
      // By the key alone, whatever the amount: a plan edited between two notices of one cycle
      // would otherwise reach the 409 of `findReplay` and roll the charge back forever.
      keyUsed: !!(await manager.findOne(Transaction, { where: { idempotencyKey: bonus.key } })),
      checksumSeen: await checksumApplied(manager, locked.id, bonus.checksum),
      lastCycle: await lastBonifiedCycle(manager, locked),
    })
    if (refusal) {
      this.logger.warn(`Cycle bonus ${bonus.key} skipped for brand ${locked.brandId}: ${refusal}`)
      return
    }

    const limits = subscriptionBonusLimits()
    if (bonus.tokens > limits.perCredit) {
      this.logger.warn(
        `Cycle bonus over the cap for brand ${bonus.brandId}: ${bonus.tokens} > ${limits.perCredit}`,
      )
      return
    }
    const thisMonth = await creditedThisMonth(manager, bonus.walletId)
    if (thisMonth + bonus.tokens > limits.perMonth) {
      this.logger.warn(
        `Cycle bonus over the monthly cap for brand ${bonus.brandId}: ` +
          `${thisMonth} + ${bonus.tokens} > ${limits.perMonth}`,
      )
      return
    }

    const reason = SubscriptionBonusReason.SUBSCRIPTION_CYCLE
    await this.tokenWallets.creditTokensIn(
      manager,
      bonus.walletId,
      bonus.tokens,
      TokenOrigin.GIFT,
      {
        brandId: locked.brandId,
        category: 'gift',
        description: `Subscription cycle ${bonus.cycleNumber} bonus`,
        referenceType: SUBSCRIPTION_BONUS_REFERENCE,
        referenceId: locked.id,
        metadata: {
          reason,
          planSlug: locked.planSlug,
          providerSubscriptionId: locked.providerSubscriptionId,
          cycleNumber: bonus.cycleNumber,
        },
      },
      bonus.key,
      (txManager, transaction) =>
        this.audit.record(txManager, {
          userId: SUBSCRIPTION_BONUS_AUTHOR,
          action: 'token_gift',
          entityType: 'wallet',
          entityId: bonus.walletId,
          changes: {
            brandId: locked.brandId,
            amount: bonus.tokens,
            reason,
            subscriptionId: locked.id,
            cycleNumber: bonus.cycleNumber,
            transactionId: transaction.id,
          },
          description: `Subscription cycle ${bonus.cycleNumber} bonus of ${bonus.tokens} tokens`,
        }),
    )
    this.logger.log(`Cycle bonus of ${bonus.tokens} credited to brand ${bonus.brandId}`)
  }
}

/** Tokens of cycle bonuses on `walletId` since the first of this UTC month. */
async function creditedThisMonth(manager: EntityManager, walletId: string): Promise<number> {
  const now = new Date()
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const row = await manager
    .createQueryBuilder(Transaction, 't')
    .select('COALESCE(SUM(t.amount), 0)', 'total')
    .where('t."walletId" = :walletId', { walletId })
    .andWhere('t."referenceType" = :ref', { ref: SUBSCRIPTION_BONUS_REFERENCE })
    .andWhere('t."createdAt" >= :monthStart', { monthStart })
    .getRawOne<{ total: string }>()
  return Number(row?.total ?? 0)
}

/** Whether an applied movement of `subscriptionId` already carries the signed `checksum`. */
async function checksumApplied(
  manager: EntityManager,
  subscriptionId: string,
  checksum: string,
): Promise<boolean> {
  const count = await manager
    .createQueryBuilder(SubscriptionEvent, 'e')
    .where('e."subscriptionId" = :subscriptionId', { subscriptionId })
    .andWhere("e.metadata ->> 'signatureChecksum' = :checksum", { checksum })
    .getCount()
  return count > 0
}

/** Highest cycle bonified for the row and the Confio subscription it holds now, `null` if none. */
async function lastBonifiedCycle(
  manager: EntityManager,
  sub: Subscription,
): Promise<number | null> {
  const row = await manager
    .createQueryBuilder(Transaction, 't')
    .select("MAX((t.metadata ->> 'cycleNumber')::bigint)", 'last')
    .where('t."referenceType" = :ref', { ref: SUBSCRIPTION_BONUS_REFERENCE })
    .andWhere('t."referenceId" = :id', { id: sub.id })
    .andWhere("t.metadata ->> 'providerSubscriptionId' = :confio", {
      confio: sub.providerSubscriptionId,
    })
    .getRawOne<{ last: string | null }>()
  return row?.last == null ? null : Number(row.last)
}
