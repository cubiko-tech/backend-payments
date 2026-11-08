import { HttpStatus, Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'

import { BillingProfile } from '../billing-profile/entities/billingProfile.entity'
import {
  createIdempotencyConflictException,
  isUniqueConstraintViolation,
} from '../checkout/checkout-idempotency'
import {
  Payment,
  PaymentProvider,
  PaymentPurpose,
  PaymentStatus,
} from '../payment/entities/payment.entity'
import { resolveRechargeTax } from '../tax/recharge-tax'
import { breakDownTaxInclusiveAmount } from '../tax/tax-inclusive-breakdown'
import { TaxService } from '../tax/tax.service'
import { TrmService } from '../trm/trm.service'
import { WalletStatus } from '../wallet/entities/wallet.entity'
import { TokenWalletService, fail } from '../wallet/token-wallet.service'
import { exactTokens, rechargePesos, storedRate } from './dropi-recharge-pricing'
import { DropiRechargeSignal } from './dropi-recharge-signal'
import { TOKEN_PRICE_USD } from './token-price'

/** What a recharge from Dropi fixes when it is created; LOC-175 credits these tokens, no others. */
export interface DropiRechargeTerms {
  tokens: number
  tokenPriceUsd: number
  bonusTokens: 0
}

export interface DropiRechargeView {
  id: string
  status: PaymentStatus
  tokens: number
  bonusTokens: number
  amount: number
  currency: string
  exchangeRate: number
  exchangeRateDate: string
  taxRate: number
}

export interface CreatedDropiRecharge {
  created: boolean
  recharge: DropiRechargeView
}

export const dropiRechargeKey = (requestId: string) => `dropi-recharge:${requestId}`

/** The TRM's share of the recharge budget (see `DropiRechargeController`). */
export const RECHARGE_TRM_TIMEOUT_MS = 3000

/**
 * Creates the `pending` payment of a recharge paid with the Dropi balance. Nothing closes it here
 * and no sweep expires it: only the result ROAX Ads reports does (LOC-175).
 */
@Injectable()
export class DropiRechargeService {
  private readonly log = new Logger(DropiRechargeService.name)

  constructor(
    @InjectRepository(Payment, 'DBWrite')
    private readonly payments: Repository<Payment>,
    @InjectRepository(BillingProfile, 'DBRead')
    private readonly billingProfiles: Repository<BillingProfile>,
    private readonly trm: TrmService,
    private readonly taxService: TaxService,
    private readonly tokenWallets: TokenWalletService,
    private readonly signal: DropiRechargeSignal,
  ) {}

  /**
   * Prices `tokens` at the day's TRM plus the country's VAT and saves the recharge `pending`. A
   * retry with the same `requestId` and tokens gets the same recharge; with other tokens, 409.
   * Tokens are fixed, priced and compared at two decimals: noise below the hundredth is dropped.
   * Rejects with no payment saved: a non-CO brand (422), no TRM within 3 s (503), no readable VAT
   * (422) and a closed token wallet (422). The token wallet itself may be left created.
   */
  async create(
    brandId: string,
    userId: string,
    requestedTokens: number,
    requestId: string,
  ): Promise<CreatedDropiRecharge> {
    const tokens = exactTokens(requestedTokens)
    const idempotencyKey = dropiRechargeKey(requestId)
    const existing = await this.payments.findOne({ where: { brandId, idempotencyKey } })
    if (existing) return { created: false, recharge: sameRequestOrConflict(existing, tokens) }

    const country = await this.billingCountry(brandId)
    if (country !== 'CO') {
      throw fail(
        'DROPI_RECHARGE_COUNTRY_UNSUPPORTED',
        'A recharge from Dropi is only priced in Colombian pesos',
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }
    const quote = await this.trm.getUsdCopRate(RECHARGE_TRM_TIMEOUT_MS)
    const tax = await resolveRechargeTax(this.taxService, country, this.log)
    const rate = storedRate(quote.rate)
    const amount = rechargePesos(tokens, rate, tax.taxRate)
    const { subtotal, taxAmount } = breakDownTaxInclusiveAmount(amount, tax.taxRate)

    const wallet = await this.tokenWallets.getOrCreate(brandId, userId)
    if (wallet.status === WalletStatus.CLOSED) {
      throw fail(
        'WALLET_CLOSED',
        'The brand token wallet is closed',
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    const terms: DropiRechargeTerms = { tokens, tokenPriceUsd: TOKEN_PRICE_USD, bonusTokens: 0 }
    const payment = this.payments.create({
      brandId,
      userId,
      idempotencyKey,
      walletId: wallet.id,
      provider: PaymentProvider.DROPI_WALLET,
      purpose: PaymentPurpose.TOKEN_RECHARGE,
      amount,
      currency: 'COP',
      exchangeRate: rate,
      exchangeRateDate: quote.date,
      status: PaymentStatus.PENDING,
      metadata: {
        country,
        taxRate: tax.taxRate,
        taxName: tax.taxName,
        subtotal,
        taxAmount,
        dropiRecharge: terms,
      },
    })
    try {
      const saved = await this.payments.save(payment)
      this.signal.changed(saved)
      return { created: true, recharge: toView(saved) }
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error
      // Another call with the same requestId inserted first.
      const winner = await this.payments.findOneOrFail({ where: { brandId, idempotencyKey } })
      return { created: false, recharge: sameRequestOrConflict(winner, tokens) }
    }
  }

  private async billingCountry(brandId: string): Promise<string> {
    const profile = await this.billingProfiles.findOne({ where: { brandId } })
    // Same default as the checkout: a brand without a billing profile is Colombian.
    return String(profile?.country || 'CO')
      .trim()
      .toUpperCase()
  }
}

function sameRequestOrConflict(existing: Payment, tokens: number): DropiRechargeView {
  const sameRequest =
    existing.provider === PaymentProvider.DROPI_WALLET &&
    Number(existing.metadata?.dropiRecharge?.tokens) === tokens
  if (!sameRequest) throw createIdempotencyConflictException()
  return toView(existing)
}

export function toView(payment: Payment): DropiRechargeView {
  const terms: DropiRechargeTerms = payment.metadata.dropiRecharge
  return {
    id: payment.id,
    status: payment.status,
    tokens: Number(terms.tokens),
    bonusTokens: Number(terms.bonusTokens),
    amount: Number(payment.amount),
    currency: payment.currency,
    exchangeRate: Number(payment.exchangeRate),
    exchangeRateDate: payment.exchangeRateDate,
    taxRate: Number(payment.metadata.taxRate),
  }
}
