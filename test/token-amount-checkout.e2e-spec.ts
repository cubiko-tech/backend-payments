/**
 * R6: One responsibility — the end-to-end lifecycle of a `token_amount` checkout (creation,
 * allowlist/idempotency/provider guards, TRM pricing, completion via notice/return/sweep, and
 * refund reclaim) sharing one PostgreSQL test instance and local TRM server.
 */
import { HttpStatus } from '@nestjs/common'
import { config as dotenvConfig } from 'dotenv'
import { DataSource } from 'typeorm'

import { CheckoutController } from '../src/checkout/checkout.controller'
import { CheckoutRequest } from '../src/checkout/checkout.service'
import { CheckoutRequestDto } from '../src/checkout/dto/checkout-request.dto'
import { ClientPlatformService } from '../src/client/client-platform.service'
import { InvoiceService } from '../src/invoice/invoice.service'
import { Payment, PaymentStatus } from '../src/payment/entities/payment.entity'
import { ConfioProvider } from '../src/provider/confio/confio.provider'
import { ProviderConfigService } from '../src/provider/provider-config.service'
import { ProviderFactory } from '../src/provider/provider.factory'
import { Refund, RefundReason } from '../src/refund/entities/refund.entity'
import { RefundService } from '../src/refund/refund.service'
import { reconcileExternalPayments } from '../src/tasks/payment-sweep'
import { Transaction } from '../src/transaction/entities/transaction.entity'
import { Wallet } from '../src/wallet/entities/wallet.entity'
import { WebhookController } from '../src/webhook/webhook.controller'
import { WebhookService } from '../src/webhook/webhook.service'
import {
  cleanPackageBrand,
  confioNotice,
  paymentsOf,
  tokenWalletOf,
} from './support/token-package.fixture'
import { TrmSource, startTrmSource, trmDown, trmOk } from './support/trm-source.fixture'
import {
  RaceInstance,
  raceConnectionOptions,
  startInstance,
  stopInstance,
} from './support/wallet-race.fixture'

dotenvConfig({ path: '.env' })

const BRAND_CO = 'b2500000-0000-4000-8000-000000000250'
const BRAND_US = 'b2500000-0000-4000-8000-000000000251'
const USER_ID = 'u2500000-0000-4000-8000-000000000250'
const ALLOWED_RETURN_URL = 'https://ads.roax.ai/tokens/return'
const ALLOWED_ALT_URL = 'https://dropi.roax.ai/tokens/return'
const COP_250 = 1_000_000

describe('Buying a token amount (PostgreSQL, LOC-250)', () => {
  let source: TrmSource
  let instance: RaceInstance
  let controller: CheckoutController
  let providerStatus: 'pending' | 'completed'
  let providerAmountCents: number
  const originalAllowedUrls = process.env.TOKEN_CHECKOUT_ALLOWED_RETURN_URLS

  const tokenAmountReq = (
    brandId: string,
    overrides: Partial<CheckoutRequest> = {},
  ): CheckoutRequest => ({
    brandId,
    userId: USER_ID,
    purpose: 'token_amount',
    provider: 'confio',
    tokens: 250,
    successUrl: ALLOWED_RETURN_URL,
    cancelUrl: ALLOWED_RETURN_URL,
    idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
    ...overrides,
  })

  const postCheckout = (
    body: Partial<CheckoutRequestDto>,
    idempotencyKey?: string,
    userId = USER_ID,
  ) =>
    controller.processCheckout(
      {
        brandId: BRAND_US,
        userId,
        purpose: 'token_amount',
        provider: 'confio',
        tokens: 250,
        successUrl: ALLOWED_RETURN_URL,
        cancelUrl: ALLOWED_RETURN_URL,
        ...body,
      } as CheckoutRequestDto,
      {
        user: { id: userId },
        headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
      },
    )

  const installFakeConfio = (target: RaceInstance) => {
    // R17: ConfioPagos is an external gateway that charges money; fake its checkout session creation.
    const createCheckout = jest.fn(async () => ({
      providerPaymentId: `stores/st-250/payments/pay-${Date.now()}`,
      checkoutUrl: 'https://pay.confio.example/token-amount',
    }))
    // R17: ConfioPagos is an external gateway; fake its status query for return and sweep tests.
    const getPaymentStatus = jest.fn(async () => ({
      status: providerStatus,
      paidAt: providerStatus === 'completed' ? new Date() : undefined,
      metadata: { amountCents: providerAmountCents, status: providerStatus.toUpperCase() },
    }))
    // R17: ConfioPagos is an external gateway that charges money; fake its HTTP answers here.
    ;(target.moduleRef.get(ProviderFactory).getProvider as jest.Mock).mockReturnValue({
      createCheckout,
      getPaymentStatus,
    })
    return { createCheckout, getPaymentStatus }
  }

  const seedBillingCountry = async (brandId: string, country: string) => {
    await instance.dataSource.query(
      `INSERT INTO billing_profiles ("brandId", "legalName", "taxId", "taxIdType", email, country)
       VALUES ($1, 'Brand 250', '900250250', 'NIT', 'billing@roax.ai', $2)`,
      [brandId, country],
    )
  }

  const cleanBrandAll = async (brandId: string) => {
    await instance.dataSource.query('DELETE FROM refunds WHERE "brandId" = $1', [brandId])
    await cleanPackageBrand(instance.dataSource, brandId)
    await instance.dataSource.query('DELETE FROM billing_profiles WHERE "brandId" = $1', [brandId])
  }

  const tokenMoves = async (brandId: string) => {
    const wallet = await tokenWalletOf(instance.dataSource, brandId)
    return wallet
      ? instance.dataSource.getRepository(Transaction).findBy({ walletId: wallet.id })
      : []
  }

  const invoicesOf = (paymentId: string) =>
    instance.dataSource.query(
      `SELECT i.subtotal, i."taxTotal", i.total, i.currency, it.description, it."productType"
         FROM invoices i JOIN invoice_items it ON it."invoiceId" = i.id WHERE i."paymentId" = $1`,
      [paymentId],
    )

  const runSweepFor = async (paymentId: string) => {
    // Age the payment past the 2-minute sweep cutoff so reconcileExternalPayments picks it up.
    await instance.dataSource.query(
      `UPDATE payments SET "createdAt" = NOW() - INTERVAL '5 minutes' WHERE id = $1`,
      [paymentId],
    )
    const paymentRepo = instance.dataSource.getRepository(Payment)
    const walletRepo = instance.dataSource.getRepository(Wallet)
    const txRepo = instance.dataSource.getRepository(Transaction)
    await reconcileExternalPayments({
      walletReadRepo: walletRepo,
      snapshotRepo: null as any,
      paymentRepo,
      transactionReadRepo: txRepo,
      dataSource: instance.dataSource,
      walletService: instance.wallet,
      providerFactory: instance.moduleRef.get(ProviderFactory),
      checkoutService: instance.checkout,
    })
  }

  beforeAll(async () => {
    process.env.TOKEN_CHECKOUT_ALLOWED_RETURN_URLS = `${ALLOWED_RETURN_URL},${ALLOWED_ALT_URL}`
    source = await startTrmSource()
    instance = await startInstance({ realBilling: true, trmUrl: source.url })
    controller = new CheckoutController(
      instance.checkout,
      instance.moduleRef.get(ProviderConfigService),
      instance.moduleRef.get(ClientPlatformService),
    )
  })

  beforeEach(async () => {
    process.env.TOKEN_CHECKOUT_ALLOWED_RETURN_URLS = `${ALLOWED_RETURN_URL},${ALLOWED_ALT_URL}`
    await cleanBrandAll(BRAND_CO)
    await cleanBrandAll(BRAND_US)
    await seedBillingCountry(BRAND_CO, 'CO')
    await seedBillingCountry(BRAND_US, 'US')
    source.reply = trmOk
    providerStatus = 'pending'
    providerAmountCents = COP_250 * 100
    installFakeConfio(instance)
  })

  afterEach(() => jest.restoreAllMocks())

  afterAll(async () => {
    await cleanBrandAll(BRAND_CO)
    await cleanBrandAll(BRAND_US)
    await stopInstance(instance)
    await source.close()
    if (originalAllowedUrls === undefined) delete process.env.TOKEN_CHECKOUT_ALLOWED_RETURN_URLS
    else process.env.TOKEN_CHECKOUT_ALLOWED_RETURN_URLS = originalAllowedUrls
  })

  it('CA4 — USD: creates a pending payment of USD 250 with its link for a US brand', async () => {
    // R15: red when prepareTokenAmount converts a non-CO brand to COP: currency is COP, not USD.
    const res = await postCheckout({ brandId: BRAND_US, tokens: 250 }, 'idem-usd-250')

    expect(res.data).toMatchObject({
      status: 'pending',
      checkoutUrl: 'https://pay.confio.example/token-amount',
    })
    const [payment] = await paymentsOf(instance.dataSource, BRAND_US)
    expect(payment).toMatchObject({
      id: res.data.paymentId,
      status: PaymentStatus.PENDING,
      currency: 'USD',
      amount: '250.00',
      exchangeRate: null,
    })
  })

  it('CA4 — COP: prices 250 tokens in COP at TRM 4000 and saves the TRM on the payment', async () => {
    // R15: red when prepareTokenAmount omits the rate on the payment: exchangeRate is null.
    const res = await postCheckout({ brandId: BRAND_CO, tokens: 250 }, 'idem-cop-250')

    const [payment] = await paymentsOf(instance.dataSource, BRAND_CO)
    expect(payment).toMatchObject({
      id: res.data.paymentId,
      status: PaymentStatus.PENDING,
      currency: 'COP',
      amount: '1000000.00',
    })
    expect(Number(payment.exchangeRate)).toBe(4000)
    expect(payment.exchangeRateDate).toBeTruthy()
  })

  it('CA4 — credits 250 purchased tokens once and creates one invoice when the notice arrives twice', async () => {
    // R15: red when creditTokenAmount drops purchasedTokensKey: the second notice credits 250 more (500).
    const { data } = await postCheckout({ brandId: BRAND_CO, tokens: 250 }, 'idem-once-250')
    const first = await instance.checkout.completeExternalPayment(
      data.paymentId,
      confioNotice(COP_250),
    )
    const second = await instance.checkout.completeExternalPayment(
      data.paymentId,
      confioNotice(COP_250),
    )

    expect([first, second]).toEqual([true, false])
    const wallet = (await tokenWalletOf(instance.dataSource, BRAND_CO))!
    expect([wallet.balance, wallet.purchasedTokens, wallet.giftTokens]).toEqual([
      '250.00',
      '250.00',
      '0.00',
    ])
    expect(await tokenMoves(BRAND_CO)).toHaveLength(1)
    expect(await invoicesOf(data.paymentId)).toEqual([
      {
        subtotal: '840336.13',
        taxTotal: '159663.87',
        total: '1000000.00',
        currency: 'COP',
        description: 'Compra de 250 tokens ROAX',
        productType: 'token_amount',
      },
    ])
  })

  it.each([5, 1_000_001, 10.123])(
    'CA4 — out of bounds: refuses %s tokens with 422 and creates no payment',
    async (tokens) => {
      // R15: red when prepareTokenAmount drops its [10, 1_000_000] / 2-decimal bound: saves a payment.
      await expect(
        postCheckout({ brandId: BRAND_US, tokens }, `idem-bound-${tokens}`),
      ).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: 'INVALID_TOKEN_AMOUNT',
      })
      expect(await paymentsOf(instance.dataSource, BRAND_US)).toHaveLength(0)
      expect(await tokenWalletOf(instance.dataSource, BRAND_US)).toBeNull()
    },
  )

  it('refuses with 400 when both tokens and packageId are sent, saving no payment', async () => {
    // R15: red when prepareTokenAmount / normalizeRequest allows both fields: creates a payment.
    await expect(
      postCheckout(
        {
          brandId: BRAND_US,
          tokens: 250,
          packageId: '3c1d5e7f-3333-4c2a-9f1a-66a0985a10e6',
        },
        'idem-both-fields',
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      code: 'CONFLICTING_TOKEN_FIELDS',
    })
    expect(await paymentsOf(instance.dataSource, BRAND_US)).toHaveLength(0)
  })

  it('Security — ignores amount: 1 in the body and charges USD 250 for 250 tokens', async () => {
    // R15: red when the price comes from req.amount instead of tokens * TOKEN_PRICE_USD: charges 1.00.
    await postCheckout({ brandId: BRAND_US, tokens: 250, amount: 1 }, 'idem-ignore-body-amount')

    const [payment] = await paymentsOf(instance.dataSource, BRAND_US)
    expect([payment.amount, payment.currency]).toEqual(['250.00', 'USD'])
  })

  it('Security — refuses a successUrl outside TOKEN_CHECKOUT_ALLOWED_RETURN_URLS with 400', async () => {
    // R15: red when assertAllowedReturnUrls skips checking successUrl: saves a payment with evil URL.
    await expect(
      postCheckout(
        { brandId: BRAND_US, tokens: 250, successUrl: 'https://evil.example' },
        'idem-evil-success',
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      code: 'INVALID_RETURN_URL',
    })
    expect(await paymentsOf(instance.dataSource, BRAND_US)).toHaveLength(0)
  })

  it('Security — refuses a token_amount checkout without Idempotency-Key with 400', async () => {
    // R15: red when normalizeRequest makes Idempotency-Key optional for token_amount: answers 201.
    await expect(postCheckout({ brandId: BRAND_US, tokens: 250 }, undefined)).rejects.toMatchObject(
      {
        status: HttpStatus.BAD_REQUEST,
        code: 'MISSING_IDEMPOTENCY_KEY',
      },
    )
    expect(await paymentsOf(instance.dataSource, BRAND_US)).toHaveLength(0)
  })

  it('Security — refuses a cancelUrl outside TOKEN_CHECKOUT_ALLOWED_RETURN_URLS with 400', async () => {
    // R15: red when assertAllowedReturnUrls only checks successUrl: evil cancelUrl gets 201.
    await expect(
      postCheckout(
        {
          brandId: BRAND_US,
          tokens: 250,
          successUrl: ALLOWED_RETURN_URL,
          cancelUrl: 'https://evil.example',
        },
        'idem-evil-cancel',
      ),
    ).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      code: 'INVALID_RETURN_URL',
    })
    expect(await paymentsOf(instance.dataSource, BRAND_US)).toHaveLength(0)
  })

  it('Security — rejects an unsigned ConfioPagos webhook with another Bearer with 401 and credits nothing', async () => {
    // R15: red when autenticarRamoOneShot accepts an unknown Bearer: completes the payment.
    const { data } = await postCheckout({ brandId: BRAND_CO, tokens: 250 }, 'idem-unsigned-webhook')
    const webhookController = new WebhookController(
      instance.moduleRef.get(WebhookService),
      null as any,
      null as any,
      null as any,
      { validateWebhookSignature: () => false } as unknown as ConfioProvider,
    )
    const rawBody = Buffer.from(
      JSON.stringify({
        event: 'payment.succeeded',
        data: {
          name: 'stores/st-250/payments/p-1',
          status: 'COMPLETED',
          correlationId: data.paymentId,
          amountCents: COP_250 * 100,
        },
      }),
    )

    await expect(
      webhookController.confio('Bearer wrong-token', { rawBody } as any),
    ).rejects.toMatchObject({ status: HttpStatus.UNAUTHORIZED })
    const [payment] = await paymentsOf(instance.dataSource, BRAND_CO)
    expect(payment.status).toBe(PaymentStatus.PENDING)
    expect((await tokenWalletOf(instance.dataSource, BRAND_CO))!.purchasedTokens).toBe('0.00')
  })

  it('Security — return and sweep leave the payment pending and credit nothing when provider says pending', async () => {
    // R15: red when reconcilePayment or the sweep completes without provider confirmation: credits 250.
    const { data } = await postCheckout({ brandId: BRAND_CO, tokens: 250 }, 'idem-still-pending')
    providerStatus = 'pending'

    const ret = await controller.paymentReturn({ paymentId: data.paymentId } as any, {
      user: { id: USER_ID },
    })
    await runSweepFor(data.paymentId)

    expect(ret.data).toEqual({ status: 'pending' })
    const [payment] = await paymentsOf(instance.dataSource, BRAND_CO)
    expect(payment.status).toBe(PaymentStatus.PENDING)
    expect((await tokenWalletOf(instance.dataSource, BRAND_CO))!.purchasedTokens).toBe('0.00')
    expect(await tokenMoves(BRAND_CO)).toHaveLength(0)
    expect(await invoicesOf(data.paymentId)).toHaveLength(0)
  })

  it('Return and sweep credit 250 purchased tokens once when the provider reports completed without a notice', async () => {
    // R15: red when reconcilePayment or the sweep skips creditTokenAmount or credits twice.
    const { data } = await postCheckout({ brandId: BRAND_CO, tokens: 250 }, 'idem-return-and-sweep')
    providerStatus = 'completed'
    providerAmountCents = COP_250 * 100

    const ret = await controller.paymentReturn({ paymentId: data.paymentId } as any, {
      user: { id: USER_ID },
    })
    await runSweepFor(data.paymentId)

    expect(ret.data).toEqual({ status: 'completed', planSlug: undefined })
    const [payment] = await paymentsOf(instance.dataSource, BRAND_CO)
    expect(payment.status).toBe(PaymentStatus.COMPLETED)
    const wallet = (await tokenWalletOf(instance.dataSource, BRAND_CO))!
    expect([wallet.balance, wallet.purchasedTokens, wallet.giftTokens]).toEqual([
      '250.00',
      '250.00',
      '0.00',
    ])
    expect(await tokenMoves(BRAND_CO)).toHaveLength(1)
    expect(await invoicesOf(data.paymentId)).toHaveLength(1)
  })

  it('Security — refuses an admin of another brand with 403 and creates no payment', async () => {
    // R15: red when CheckoutController skips canViewBrandCredit: creates a payment for the foreign brand.
    jest
      .spyOn(instance.moduleRef.get(ClientPlatformService), 'canViewBrandCredit')
      .mockResolvedValueOnce(false)

    await expect(
      postCheckout({ brandId: BRAND_US, tokens: 250 }, 'idem-other-brand', 'other-brand-admin'),
    ).rejects.toMatchObject({
      status: HttpStatus.FORBIDDEN,
      code: 'forbidden',
    })
    expect(await paymentsOf(instance.dataSource, BRAND_US)).toHaveLength(0)
  })

  it('answers 409 IDEMPOTENCY_KEY_CONFLICT when the same Idempotency-Key is reused with another token count', async () => {
    // R15: red when buildIdempotencyFingerprint omits tokens: the 300-token call replays the 250 payment.
    const first = await postCheckout({ brandId: BRAND_US, tokens: 250 }, 'idem-reused-diff-tokens')
    await expect(
      postCheckout({ brandId: BRAND_US, tokens: 300 }, 'idem-reused-diff-tokens'),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
    })

    const rows = await paymentsOf(instance.dataSource, BRAND_US)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(first.data.paymentId)
    expect(rows[0].amount).toBe('250.00')
  })

  it('Bounds — answers 503 EXCHANGE_RATE_UNAVAILABLE and saves no payment when the TRM does not respond for a CO brand', async () => {
    // R15: red when prepareTokenAmount prices a CO brand without the TRM: saves a payment.
    const down = await startTrmSource(trmDown)
    const cold = await startInstance({ realBilling: true, trmUrl: down.url })
    try {
      installFakeConfio(cold)
      await expect(
        cold.checkout.processCheckout(
          tokenAmountReq(BRAND_CO, { idempotencyKey: 'idem-trm-down' }),
        ),
      ).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: 'EXCHANGE_RATE_UNAVAILABLE',
      })
      expect(down.hits).toBe(1)
      expect(await paymentsOf(instance.dataSource, BRAND_CO)).toHaveLength(0)
    } finally {
      await stopInstance(cold)
      await down.close()
    }
  })

  it('recovers a partial completion via the sweep without crediting the 250 tokens a second time', async () => {
    // R15: red when creditTokenAmount drops its idempotency key: the sweep credits 250 again (500).
    const { data } = await postCheckout({ brandId: BRAND_CO, tokens: 250 }, 'idem-partial-sweep')
    jest
      .spyOn(instance.moduleRef.get(InvoiceService), 'create')
      .mockRejectedValueOnce(new Error('invoice db down'))

    await expect(
      instance.checkout.completeExternalPayment(data.paymentId, confioNotice(COP_250)),
    ).rejects.toThrow('invoice db down')
    expect((await paymentsOf(instance.dataSource, BRAND_CO))[0].status).toBe(
      PaymentStatus.PROCESSING,
    )

    providerStatus = 'completed'
    await runSweepFor(data.paymentId)

    expect((await paymentsOf(instance.dataSource, BRAND_CO))[0].status).toBe(
      PaymentStatus.COMPLETED,
    )
    expect((await tokenWalletOf(instance.dataSource, BRAND_CO))!.purchasedTokens).toBe('250.00')
    expect(await tokenMoves(BRAND_CO)).toHaveLength(1)
    expect(await invoicesOf(data.paymentId)).toHaveLength(1)
  })

  it('reclaims the 250 purchased tokens when a full refund of a token_amount payment is approved', async () => {
    // R15: red when isTokenPackage / packageTokensOf ignores TOKEN_AMOUNT: refund leaves the 250 tokens.
    const { data } = await postCheckout({ brandId: BRAND_US, tokens: 250 }, 'idem-refund-250')
    await instance.checkout.completeExternalPayment(data.paymentId, confioNotice(250))

    const refundSource = new DataSource({
      ...raceConnectionOptions(),
      entities: [Refund, Payment, Wallet, Transaction],
    })
    await refundSource.initialize()
    try {
      const refundRepo = refundSource.getRepository(Refund)
      const paymentRepo = refundSource.getRepository(Payment)
      const refunds = new RefundService(refundRepo, refundRepo, paymentRepo)
      await expect(
        refunds.request({
          brandId: BRAND_US,
          paymentId: data.paymentId,
          amount: 100,
          currency: 'USD',
          reason: RefundReason.CUSTOMER_REQUEST,
          requestedBy: USER_ID,
        }),
      ).rejects.toMatchObject({ status: 422, code: 'TOKEN_PACKAGE_PARTIAL_REFUND' })

      const requested = await refunds.request({
        brandId: BRAND_US,
        paymentId: data.paymentId,
        amount: 250,
        currency: 'USD',
        reason: RefundReason.CUSTOMER_REQUEST,
        requestedBy: USER_ID,
      })
      await refunds.approve(requested.data!.id, 'superadmin-250')
    } finally {
      await refundSource.destroy()
    }

    const wallet = (await tokenWalletOf(instance.dataSource, BRAND_US))!
    expect([wallet.balance, wallet.purchasedTokens]).toEqual(['0.00', '0.00'])
  })

  it.each([
    ['wallet', HttpStatus.UNPROCESSABLE_ENTITY, 'TOKEN_PACKAGE_EXTERNAL_ONLY'],
    ['dropi', HttpStatus.BAD_REQUEST, 'PROVIDER_NOT_AVAILABLE'],
  ] as const)(
    'refuses provider %s for token_amount with %i %s, saving no payment',
    async (provider, status, code) => {
      // R15: red when prepareTokenAmount or assertProviderAvailable allows wallet or dropi.
      await expect(
        postCheckout({ brandId: BRAND_CO, tokens: 250, provider }, `idem-prov-${provider}`),
      ).rejects.toMatchObject({ status, code })
      expect(await paymentsOf(instance.dataSource, BRAND_CO)).toHaveLength(0)
    },
  )
})
