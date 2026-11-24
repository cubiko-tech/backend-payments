// R6: One responsibility, the single /admin HTTP surface; splitting it by domain is its own task.
import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  Req,
  UseGuards,
  ParseUUIDPipe,
  BadRequestException,
  HttpStatus,
  Optional,
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, MoreThan, In, Between } from 'typeorm'
import { Subscription, SubscriptionStatus } from '../subscription/entities/subscription.entity'
import { Payment, PaymentProvider, PaymentStatus } from '../payment/entities/payment.entity'
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { ProviderConfig } from '../provider/entities/providerConfig.entity'
import { Transaction, TransactionType } from '../transaction/entities/transaction.entity'
import { MovementAudit } from '../transaction/movement-audit'
import { AuditService } from '../audit/audit.service'
import {
  claimFailedPaymentForRetry,
  WalletCheckoutLostError,
} from '../checkout/wallet-payment-close'
import { CreditService } from '../credit/credit.service'
import {
  CREDIT_ACTIVATION_REQUEST_STATUSES,
  CreditActivationRequestStatus,
} from '../credit/credit.types'
import { ApiAuthGuard } from '../shared/auth/api-auth.guard'
import {
  AllowServerToken,
  RequirePermission,
  RequireSessionUser,
  RequireSuperAdmin,
} from '../shared/auth/require-permission.decorator'
import { isUniqueViolation } from '../shared/db/unique-violation'
import { RequestException } from '../shared/exception/request.exception'
import { assertNotTokenCurrency, isTokenCurrency } from '../wallet/token-origin'
import { TokenWalletService } from '../wallet/token-wallet.service'
import { WalletService } from '../wallet/wallet.service'
import { UpdateActivationRequestDto } from '../credit/dto/update-activation-request.dto'
import { adminIdempotencyKey } from './admin-idempotency-key'
import { ExtendSubscriptionDto } from './dto/extend-subscription.dto'
import { AdminCreateWalletDto, AdjustWalletDto } from './dto/admin-wallet.dto'
import {
  PAYMENT_LIST_ORDER_FIELDS,
  PaymentsListQueryDto,
  SUBSCRIPTION_LIST_ORDER_FIELDS,
  SubscriptionsListQueryDto,
  WALLET_LIST_ORDER_FIELDS,
  WalletsListQueryDto,
} from './dto/admin-list-query.dto'
import { CreateProviderConfigDto, UpdateProviderConfigDto } from './dto/admin-provider.dto'

// Backslash is Postgres's default LIKE escape, so `%` and `_` in the search match themselves.
const containsPattern = (search: string) => `%${search.replace(/[\\%_]/g, '\\$&')}%`

@ApiTags('Admin')
@Controller('admin')
@UseGuards(ApiAuthGuard)
@RequireSuperAdmin()
@RequireSessionUser()
export class AdminController {
  constructor(
    @InjectRepository(Subscription, 'DBRead')
    private readonly subscriptionReadRepo: Repository<Subscription>,
    @InjectRepository(Subscription, 'DBWrite')
    private readonly subscriptionWriteRepo: Repository<Subscription>,
    @InjectRepository(Payment, 'DBRead')
    private readonly paymentReadRepo: Repository<Payment>,
    @InjectRepository(Payment, 'DBWrite')
    private readonly paymentWriteRepo: Repository<Payment>,
    @InjectRepository(Wallet, 'DBRead')
    private readonly walletReadRepo: Repository<Wallet>,
    @InjectRepository(Wallet, 'DBWrite')
    private readonly walletWriteRepo: Repository<Wallet>,
    @InjectRepository(WalletBalanceSnapshot, 'DBRead')
    private readonly snapshotReadRepo: Repository<WalletBalanceSnapshot>,
    @InjectRepository(ProviderConfig, 'DBRead')
    private readonly providerReadRepo: Repository<ProviderConfig>,
    @InjectRepository(ProviderConfig, 'DBWrite')
    private readonly providerWriteRepo: Repository<ProviderConfig>,
    @InjectRepository(Transaction, 'DBWrite')
    private readonly transactionWriteRepo: Repository<Transaction>,
    private readonly auditService: AuditService,
    private readonly creditService: CreditService,
    private readonly walletService: WalletService,
    @Optional() private readonly tokenWallets?: TokenWalletService,
  ) {}

  @Get('subscriptions')
  // backend-processes lists subscriptions for its panel with ACCESS_SERVER.
  @AllowServerToken()
  @ApiOperation({ summary: 'Listado paginado de suscripciones con filtros' })
  @ApiResponse({ status: 200, description: 'Suscripciones paginadas' })
  async subscriptionsList(@Query() query: SubscriptionsListQueryDto) {
    const { page, perPage, status, planSlug, provider, search, orderBy, order } = query
    const p = page ?? 1
    const limit = perPage ?? 20
    const skip = (p - 1) * limit

    const qb = this.subscriptionReadRepo.createQueryBuilder('s')

    if (status) qb.andWhere('s.status = :status', { status })
    if (planSlug) qb.andWhere('s.planSlug = :planSlug', { planSlug })
    if (provider) qb.andWhere('s.provider = :provider', { provider })
    if (search) {
      qb.andWhere('("s"."brandId" ILIKE :q OR s.planSlug ILIKE :q)', { q: containsPattern(search) })
    }

    const sortField = SUBSCRIPTION_LIST_ORDER_FIELDS.includes(orderBy || '') ? orderBy : 'createdAt'
    qb.orderBy(`s.${sortField}`, order ?? 'DESC')

    const [data, total] = await qb.skip(skip).take(limit).getManyAndCount()

    return {
      data,
      count: total,
      meta: { page: p, perPage: limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  @Get('subscriptions/summary')
  @ApiOperation({ summary: 'Resumen de suscripciones por plan y estado' })
  @ApiResponse({ status: 200, description: 'Resumen de suscripciones' })
  async subscriptionsSummary() {
    const all = await this.subscriptionReadRepo.find()

    const byPlan: Record<string, Record<string, number>> = {}
    const byStatus: Record<string, number> = {}

    for (const sub of all) {
      if (!byPlan[sub.planSlug]) byPlan[sub.planSlug] = {}
      byPlan[sub.planSlug][sub.status] = (byPlan[sub.planSlug][sub.status] || 0) + 1

      byStatus[sub.status] = (byStatus[sub.status] || 0) + 1
    }

    return {
      data: {
        total: all.length,
        byStatus,
        byPlan,
      },
    }
  }

  @Get('subscriptions/expiring')
  @ApiOperation({ summary: 'Suscripciones que expiran en los próximos N días' })
  @ApiResponse({ status: 200, description: 'Lista de suscripciones próximas a expirar' })
  async subscriptionsExpiring(@Query('days') days?: number) {
    const d = days || 7
    const now = new Date()
    const limit = new Date()
    limit.setDate(limit.getDate() + d)

    const expiring = await this.subscriptionReadRepo.find({
      where: {
        status: In([SubscriptionStatus.ACTIVE, SubscriptionStatus.PAST_DUE]),
        currentPeriodEnd: Between(now, limit),
      },
      order: { currentPeriodEnd: 'ASC' },
    })

    return { data: expiring, meta: { days: d, count: expiring.length } }
  }

  @Get('subscriptions/past-due')
  @ApiOperation({ summary: 'Suscripciones con pago pendiente/fallido' })
  @ApiResponse({ status: 200, description: 'Lista de suscripciones past_due' })
  async subscriptionsPastDue() {
    const pastDue = await this.subscriptionReadRepo.find({
      where: { status: SubscriptionStatus.PAST_DUE },
      order: { nextBillingDate: 'ASC' },
    })

    return { data: pastDue, meta: { count: pastDue.length } }
  }

  @Post('subscriptions/:id/extend')
  @ApiOperation({ summary: 'Extender suscripción manualmente (Admin)' })
  @ApiResponse({ status: 200, description: 'Suscripción extendida' })
  @ApiResponse({ status: 404, description: 'SUBSCRIPTION_NOT_FOUND' })
  async extendSubscription(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ExtendSubscriptionDto,
    @Req() req?: any,
  ) {
    const sub = await this.subscriptionWriteRepo.findOne({ where: { id } })
    if (!sub) {
      throw new RequestException(
        { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Suscripción no encontrada' },
        HttpStatus.NOT_FOUND,
      )
    }

    const newEnd = new Date(sub.currentPeriodEnd)
    newEnd.setDate(newEnd.getDate() + body.days)

    sub.currentPeriodEnd = newEnd
    sub.nextBillingDate = newEnd
    // Pending cancellations gate access on `accessEndsAt` (`subscription.entity.ts`);
    // shift it only when already set so active rows are not marked for cancellation.
    if (sub.accessEndsAt) {
      const nuevoFinDeAcceso = new Date(sub.accessEndsAt)
      nuevoFinDeAcceso.setDate(nuevoFinDeAcceso.getDate() + body.days)
      sub.accessEndsAt = nuevoFinDeAcceso
    }
    if (sub.status === SubscriptionStatus.PAST_DUE || sub.status === SubscriptionStatus.EXPIRED) {
      sub.status = SubscriptionStatus.ACTIVE
      sub.retryCount = 0
    }

    await this.subscriptionWriteRepo.save(sub)

    await this.auditService.log(
      req?.user?.id || 'admin',
      'subscription_extended',
      'subscription',
      id,
      { days: body.days, newEnd: newEnd.toISOString() },
      body.reason || `Extendida ${body.days} días manualmente`,
    )

    return { data: sub }
  }

  @Get('payments')
  @ApiOperation({ summary: 'Listado paginado de pagos con filtros' })
  @ApiResponse({ status: 200, description: 'Pagos paginados' })
  async paymentsList(@Query() query: PaymentsListQueryDto) {
    const { page, perPage, status, provider, purpose, search, orderBy, order } = query
    const p = page ?? 1
    const limit = perPage ?? 20
    const skip = (p - 1) * limit

    const qb = this.paymentReadRepo.createQueryBuilder('p')

    if (status) qb.andWhere('p.status = :status', { status })
    if (provider) qb.andWhere('p.provider = :provider', { provider })
    if (purpose) qb.andWhere('p.purpose = :purpose', { purpose })
    if (search) {
      qb.andWhere('("p"."brandId" ILIKE :q OR p.providerPaymentId ILIKE :q)', {
        q: containsPattern(search),
      })
    }

    const sortField = PAYMENT_LIST_ORDER_FIELDS.includes(orderBy || '') ? orderBy : 'createdAt'
    qb.orderBy(`p.${sortField}`, order ?? 'DESC')

    const [data, total] = await qb.skip(skip).take(limit).getManyAndCount()

    return {
      data,
      count: total,
      meta: { page: p, perPage: limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  @Get('payments/pending')
  @ApiOperation({ summary: 'Pagos pendientes de completar' })
  @ApiResponse({ status: 200, description: 'Lista de pagos pendientes' })
  async paymentsPending() {
    const pending = await this.paymentReadRepo.find({
      where: { status: In([PaymentStatus.PENDING, PaymentStatus.PROCESSING]) },
      order: { createdAt: 'DESC' },
      take: 100,
    })

    return { data: pending, meta: { count: pending.length } }
  }

  @Get('payments/failed')
  @ApiOperation({ summary: 'Pagos fallidos recientes' })
  @ApiResponse({ status: 200, description: 'Lista de pagos fallidos' })
  async paymentsFailed(@Query('days') days?: number) {
    const d = days || 7
    const since = new Date()
    since.setDate(since.getDate() - d)

    const failed = await this.paymentReadRepo.find({
      where: {
        status: PaymentStatus.FAILED,
        createdAt: MoreThan(since),
      },
      order: { createdAt: 'DESC' },
      take: 100,
    })

    return { data: failed, meta: { count: failed.length, days: d } }
  }

  @Get('payments/stats')
  @ApiOperation({ summary: 'Estadísticas de pagos por estado y proveedor' })
  @ApiResponse({ status: 200, description: 'Estadísticas de pagos' })
  async paymentsStats(@Query('days') days?: number) {
    const d = days || 30
    const since = new Date()
    since.setDate(since.getDate() - d)

    const payments = await this.paymentReadRepo.find({
      where: { createdAt: MoreThan(since) },
    })

    const byStatus: Record<string, number> = {}
    const byProvider: Record<string, number> = {}
    let totalAmount = 0
    let completedAmount = 0

    for (const p of payments) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1
      byProvider[p.provider] = (byProvider[p.provider] || 0) + 1
      totalAmount += Number(p.amount)
      if (p.status === PaymentStatus.COMPLETED) {
        completedAmount += Number(p.amount)
      }
    }

    return {
      data: {
        period: { days: d, since: since.toISOString() },
        total: payments.length,
        totalAmount: Math.round(totalAmount * 100) / 100,
        completedAmount: Math.round(completedAmount * 100) / 100,
        byStatus,
        byProvider,
      },
    }
  }

  @Post('payments/:id/retry')
  @ApiOperation({ summary: 'Reintentar cobro de pago fallido manualmente (Admin)' })
  @ApiResponse({ status: 200, description: 'Pago marcado para reintento' })
  @ApiResponse({ status: 404, description: 'PAYMENT_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'PAYMENT_NOT_FAILED, PAYMENT_NOT_RETRYABLE, o tiene movimientos',
  })
  async retryPayment(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    const payment = await this.paymentWriteRepo.findOne({ where: { id } })
    if (!payment) {
      throw new RequestException(
        { code: 'PAYMENT_NOT_FOUND', message: 'Pago no encontrado' },
        HttpStatus.NOT_FOUND,
      )
    }
    if (payment.status !== PaymentStatus.FAILED) {
      throw new RequestException(
        {
          code: 'PAYMENT_NOT_FAILED',
          message: `Pago no está en estado failed (actual: ${payment.status})`,
        },
        HttpStatus.CONFLICT,
      )
    }
    // Only the result Dropi reports may reopen a recharge paid with its balance.
    if (payment.provider === PaymentProvider.DROPI_WALLET) {
      throw new RequestException(
        { code: 'PAYMENT_NOT_RETRYABLE', message: 'Una recarga desde Dropi no se reintenta' },
        HttpStatus.CONFLICT,
      )
    }

    const claimed = await this.claimForAdminRetry(payment)
    if (!claimed.affected) {
      throw new RequestException(
        { code: 'PAYMENT_NOT_FAILED', message: 'El pago cambió de estado durante el reintento' },
        HttpStatus.CONFLICT,
      )
    }

    await this.auditService.log(
      req?.user?.id || 'admin',
      'payment_retry',
      'payment',
      id,
      { previousStatus: PaymentStatus.FAILED },
      'Reintento manual de pago',
    )

    return { data: { message: 'Pago marcado para reintento', paymentId: id } }
  }

  /**
   * Moves a failed payment without a debit back to `pending` through the checkout's claim, keeping
   * its `createdAt`. Throws 409 when its money was credited back or it still holds a debit.
   */
  private async claimForAdminRetry(payment: Payment) {
    try {
      return await claimFailedPaymentForRetry(
        payment.id,
        { status: PaymentStatus.PENDING },
        payment.createdAt,
        this.paymentWriteRepo.manager.connection,
        { refuseDebited: true },
      )
    } catch (error) {
      if (error instanceof WalletCheckoutLostError) {
        throw new RequestException(
          { code: 'PAYMENT_CREDITED_BACK', message: 'El dinero del pago ya se devolvió' },
          HttpStatus.CONFLICT,
        )
      }
      throw error
    }
  }

  @Get('credit/activation-requests')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:runs')
  @ApiOperation({ summary: 'Listado paginado de solicitudes de activación de crédito' })
  @ApiResponse({ status: 200, description: 'Solicitudes de activación paginadas' })
  async activationRequests(
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
    @Query('status') status?: string,
    @Query('search') search?: string,
  ) {
    const p = Math.max(1, Number(page) || 1)
    const limit = Math.min(100, Math.max(1, Number(perPage) || 20))
    if (
      status &&
      !CREDIT_ACTIVATION_REQUEST_STATUSES.includes(status as CreditActivationRequestStatus)
    ) {
      throw new BadRequestException('status inválido')
    }
    const { data, total } = await this.creditService.listActivationRequests({
      page: p,
      perPage: limit,
      status: (status as CreditActivationRequestStatus) || undefined,
      search,
    })

    return {
      data,
      count: total,
      meta: { page: p, perPage: limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  @Patch('credit/activation-requests/:id')
  @UseGuards(ApiAuthGuard)
  @RequirePermission('credit:runs')
  @ApiOperation({ summary: 'Actualizar estado/notas de una solicitud de activación de crédito' })
  @ApiResponse({ status: 200, description: 'Solicitud actualizada' })
  async updateActivationRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateActivationRequestDto,
    @Req() req: any,
  ) {
    const actor = req?.user?.id || null
    const updated = await this.creditService.updateActivationRequest(id, body, actor)

    await this.auditService.log(
      actor || 'admin',
      'credit_activation_request_updated',
      'credit_activation_request',
      id,
      { status: updated.status, notesUpdated: body.notes !== undefined },
      body.status ? `Solicitud de activación → ${body.status}` : 'Actualización de solicitud',
    )

    return { data: updated }
  }

  @Get('dropi/batch-status')
  @ApiOperation({ summary: 'Estado del último batch de cobros Dropi' })
  @ApiResponse({ status: 200, description: 'Estado del batch' })
  async dropiBatchStatus() {
    const recentDropiPayments = await this.paymentReadRepo.find({
      where: { provider: 'dropi' as any },
      order: { createdAt: 'DESC' },
      take: 50,
    })

    const byStatus: Record<string, number> = {}
    for (const p of recentDropiPayments) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1
    }

    return {
      data: {
        totalRecent: recentDropiPayments.length,
        byStatus,
        lastPayment: recentDropiPayments[0] || null,
      },
    }
  }

  @Get('wallets')
  @ApiOperation({ summary: 'Listado paginado de wallets con filtros' })
  @ApiResponse({ status: 200, description: 'Wallets paginadas' })
  async walletsList(@Query() query: WalletsListQueryDto) {
    const { page, perPage, status, provider, currency, search, brandIds, orderBy, order } = query
    const p = page ?? 1
    const limit = perPage ?? 20
    const skip = (p - 1) * limit

    const qb = this.walletReadRepo.createQueryBuilder('w')

    if (status) qb.andWhere('w.status = :status', { status })
    if (provider) qb.andWhere('w.provider = :provider', { provider })
    if (currency) qb.andWhere('w.currency = :currency', { currency })
    // The admin sends the brands it resolved from a name plus that name as `search`, for the label.
    const matches = [
      ...(brandIds ? ['"w"."brandId" IN (:...brandIds)'] : []),
      ...(search ? ['"w"."brandId" ILIKE :q', 'w.label ILIKE :q'] : []),
    ]
    if (matches.length) {
      qb.andWhere(`(${matches.join(' OR ')})`, {
        brandIds,
        q: search ? containsPattern(search) : undefined,
      })
    }

    const sortField = WALLET_LIST_ORDER_FIELDS.includes(orderBy || '') ? orderBy : 'createdAt'
    qb.orderBy(`w.${sortField}`, order ?? 'DESC')

    const [data, total] = await qb.skip(skip).take(limit).getManyAndCount()

    return {
      data,
      count: total,
      meta: { page: p, perPage: limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  @Post('wallets')
  // backend-platform opens the brand's wallet with ACCESS_SERVER when the brand is created.
  @AllowServerToken()
  @ApiOperation({ summary: 'Crear wallet para una marca con balance inicial (Admin)' })
  @ApiResponse({ status: 201, description: 'Wallet creada' })
  @ApiResponse({ status: 409, description: 'WALLET_ALREADY_EXISTS' })
  async createWallet(@Body() body: AdminCreateWalletDto, @Req() req?: any) {
    // The brand token wallet comes only from TokenWalletService: one per brand, balance by origin.
    assertNotTokenCurrency(body.currency)
    if (req?.user?.isServer && (body.balance ?? 0) !== 0) {
      throw new RequestException(
        {
          code: 'SERVER_INITIAL_BALANCE_FORBIDDEN',
          message: 'Server token cannot open a wallet with a non-zero initial balance',
        },
        HttpStatus.BAD_REQUEST,
      )
    }
    const userId = body.userId || body.brandId
    const existing = await this.walletReadRepo.findOne({
      where: { brandId: body.brandId, provider: body.provider as any, currency: body.currency },
    })
    const walletExists = async () => {
      await this.tokenWallets!.getOrCreate(body.brandId, userId)
      return new RequestException(
        {
          code: 'WALLET_ALREADY_EXISTS',
          message: `Ya existe una wallet ${body.provider}/${body.currency} para esta marca`,
        },
        HttpStatus.CONFLICT,
      )
    }
    if (existing) throw await walletExists()

    const wallet = this.walletWriteRepo.create({
      brandId: body.brandId,
      userId,
      provider: body.provider as any,
      currency: body.currency.toUpperCase(),
      label: body.label || null,
      balance: body.balance || 0,
      status: WalletStatus.ACTIVE,
    })

    // The read above runs on the replica: a lagging replica or a concurrent create reaches the unique index.
    const saved = await this.walletWriteRepo.save(wallet).catch(async (error: unknown) => {
      throw isUniqueViolation(error) ? await walletExists() : error
    })
    await this.tokenWallets!.getOrCreate(body.brandId, userId)

    await this.auditService.log(
      req?.user?.id || 'admin',
      'wallet_created',
      'wallet',
      saved.id,
      {
        brandId: body.brandId,
        provider: body.provider,
        currency: body.currency,
        balance: body.balance || 0,
        label: body.label,
      },
      `Wallet ${body.provider}/${body.currency} creada manualmente para marca ${body.brandId}`,
    )

    return { data: saved }
  }

  @Post('wallets/:id/toggle-freeze')
  @ApiOperation({ summary: 'Congelar o descongelar wallet (Admin)' })
  @ApiResponse({ status: 200, description: 'Estado de wallet actualizado' })
  @ApiResponse({ status: 404, description: 'WALLET_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'WALLET_CLOSED, WALLET_STATUS_CHANGED' })
  async toggleFreezeWallet(@Param('id', ParseUUIDPipe) id: string, @Req() req?: any) {
    const wallet = await this.walletWriteRepo.findOne({ where: { id } })
    if (!wallet) {
      throw new RequestException(
        { code: 'WALLET_NOT_FOUND', message: 'Wallet no encontrada' },
        HttpStatus.NOT_FOUND,
      )
    }
    if (wallet.status === WalletStatus.CLOSED) {
      throw new RequestException(
        { code: 'WALLET_CLOSED', message: 'Wallet cerrada, no se puede modificar' },
        HttpStatus.CONFLICT,
      )
    }

    const previousStatus = wallet.status
    const newStatus =
      previousStatus === WalletStatus.FROZEN ? WalletStatus.ACTIVE : WalletStatus.FROZEN

    // Writes only the status, and only over the status read: never a stale balance or a closed row.
    const toggled = await this.walletWriteRepo.update(
      { id, status: previousStatus },
      { status: newStatus },
    )
    if (!toggled.affected) {
      throw new RequestException(
        { code: 'WALLET_STATUS_CHANGED', message: 'La wallet cambió de estado, vuelva a intentar' },
        HttpStatus.CONFLICT,
      )
    }

    await this.auditService.log(
      req?.user?.id || 'admin',
      newStatus === WalletStatus.FROZEN ? 'wallet_frozen' : 'wallet_unfrozen',
      'wallet',
      id,
      { previousStatus, newStatus },
      `Wallet ${newStatus === WalletStatus.FROZEN ? 'congelada' : 'descongelada'} manualmente`,
    )

    return { data: await this.walletWriteRepo.findOne({ where: { id } }) }
  }

  @Post('wallets/:id/adjust')
  @ApiOperation({ summary: 'Acreditar o debitar fondos de una wallet (Admin)' })
  @ApiResponse({ status: 201, description: 'Ajuste realizado, o el primero bajo esta llave' })
  @ApiResponse({ status: 400, description: 'Falta la llave, o el monto o el tipo no son válidos' })
  @ApiResponse({ status: 403, description: 'No es una sesión de super admin (token de servidor)' })
  @ApiResponse({ status: 404, description: 'WALLET_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'IDEMPOTENCY_KEY_CONFLICT: la llave es de otro movimiento',
  })
  @ApiResponse({
    status: 422,
    description:
      'WALLET_CURRENCY_MISMATCH (TKN), WALLET_CLOSED, WALLET_FROZEN, INSUFFICIENT_BALANCE',
  })
  async adjustWallet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdjustWalletDto,
    @Req() req?: any,
  ) {
    const actor = req?.user?.id || 'admin'
    const amount = Number(body.amount)
    // Write connection: the replica may not have a wallet created a moment ago.
    const wallet = await this.walletWriteRepo.findOne({ where: { id } })
    if (!wallet) {
      throw new RequestException(
        { code: 'WALLET_NOT_FOUND', message: 'Wallet not found' },
        HttpStatus.NOT_FOUND,
      )
    }
    if (isTokenCurrency(wallet.currency)) {
      throw new RequestException(
        { code: 'WALLET_CURRENCY_MISMATCH', message: 'Token wallets are not adjusted here' },
        HttpStatus.UNPROCESSABLE_ENTITY,
      )
    }

    const key = adminIdempotencyKey(body.idempotencyKey)
    const previous = await this.transactionWriteRepo.findOne({ where: { idempotencyKey: key } })
    if (previous) {
      return { data: { wallet, transaction: sameAdjustment(previous, id, body.type, amount) } }
    }

    const data = {
      brandId: wallet.brandId,
      category: body.category || 'admin_adjustment',
      description: body.description || `Ajuste manual (${body.type})`,
      referenceType: 'admin',
      referenceId: actor,
    }
    const audit: MovementAudit = (manager, transaction) =>
      this.auditService.record(manager, {
        userId: actor,
        action: body.type === 'credit' ? 'wallet_credit' : 'wallet_debit',
        entityType: 'wallet',
        entityId: id,
        changes: {
          amount,
          balanceBefore: Number(transaction.balanceBefore),
          balanceAfter: Number(transaction.balanceAfter),
          category: body.category,
          transactionId: transaction.id,
        },
        description: `${body.type === 'credit' ? 'Crédito' : 'Débito'} manual de ${amount} ${wallet.currency}`,
      })
    const result =
      body.type === 'credit'
        ? await this.walletService.credit(id, amount, data, key, undefined, audit)
        : await this.walletService.debit(id, amount, data, undefined, key, audit)
    if ('error' in result) {
      throw new RequestException(
        { code: 'WALLET_ADJUST_FAILED', message: String(result.error) },
        HttpStatus.INTERNAL_SERVER_ERROR,
      )
    }
    // A concurrent request under the same key comes back as its movement, not as an error.
    sameAdjustment(result.data.transaction, id, body.type, amount)

    return { data: result.data }
  }

  @Get('wallets/summary')
  @ApiOperation({ summary: 'Total de dinero en el sistema por proveedor y moneda' })
  @ApiResponse({ status: 200, description: 'Resumen de wallets' })
  async walletsSummary() {
    const wallets = await this.walletReadRepo.find({
      where: { status: In([WalletStatus.ACTIVE, WalletStatus.FROZEN]) },
    })

    const groups: Record<
      string,
      { count: number; total: number; currency: string; provider: string }
    > = {}

    for (const w of wallets) {
      const key = `${w.provider}:${w.currency}`
      if (!groups[key]) {
        groups[key] = { count: 0, total: 0, currency: w.currency, provider: w.provider }
      }
      groups[key].count++
      groups[key].total += Number(w.balance)
    }

    const summary = Object.values(groups).map((g) => ({
      ...g,
      total: Math.round(g.total * 100) / 100,
    }))

    return {
      data: {
        totalWallets: wallets.length,
        groups: summary,
      },
    }
  }

  @Get('wallets/inconsistent')
  @ApiOperation({ summary: 'Wallets con reconciliación fallida (últimos snapshots)' })
  @ApiResponse({ status: 200, description: 'Lista de wallets inconsistentes' })
  async walletsInconsistent() {
    const inconsistent = await this.snapshotReadRepo.find({
      where: { isConsistent: false },
      order: { snapshotAt: 'DESC' },
      take: 50,
    })

    return { data: inconsistent, meta: { count: inconsistent.length } }
  }

  @Get('audit-log')
  @ApiOperation({ summary: 'Log de auditoría paginado con filtros' })
  @ApiResponse({ status: 200, description: 'Entradas de auditoría' })
  async getAuditLog(
    @Query('entityType') entityType?: string,
    @Query('action') action?: string,
    @Query('userId') userId?: string,
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
  ) {
    return this.auditService.findPaginated({
      entityType,
      action,
      userId,
      page: Number(page) || 1,
      perPage: Number(perPage) || 20,
    })
  }

  @Get('providers')
  @ApiOperation({ summary: 'Listar todos los proveedores configurados' })
  @ApiResponse({ status: 200, description: 'Lista de proveedores' })
  async providersList() {
    const providers = await this.providerReadRepo.find({
      order: { country: 'ASC', priority: 'ASC' },
    })
    return { data: providers }
  }

  @Post('providers')
  @ApiOperation({ summary: 'Crear configuración de proveedor' })
  @ApiResponse({ status: 201, description: 'Proveedor creado' })
  @ApiResponse({ status: 409, description: 'PROVIDER_CONFIG_ALREADY_EXISTS' })
  async createProvider(@Body() body: CreateProviderConfigDto) {
    const existing = await this.providerReadRepo.findOne({
      where: { country: body.country.toUpperCase(), provider: body.provider.toLowerCase() },
    })
    const providerExists = new RequestException(
      {
        code: 'PROVIDER_CONFIG_ALREADY_EXISTS',
        message: `El proveedor ${body.provider} ya existe para ${body.country}`,
      },
      HttpStatus.CONFLICT,
    )
    if (existing) throw providerExists

    const config = this.providerWriteRepo.create({
      country: body.country.toUpperCase(),
      provider: body.provider.toLowerCase(),
      isActive: body.isActive !== false,
      priority: body.priority || 0,
      metadata: body.metadata || null,
    })

    // Same replica read as createWallet: the unique index is the check that holds under a race.
    const saved = await this.providerWriteRepo.save(config).catch((error: unknown) => {
      throw isUniqueViolation(error) ? providerExists : error
    })
    return { data: saved }
  }

  @Patch('providers/:id')
  @ApiOperation({ summary: 'Actualizar configuración de proveedor' })
  @ApiResponse({ status: 200, description: 'Proveedor actualizado' })
  @ApiResponse({ status: 404, description: 'PROVIDER_CONFIG_NOT_FOUND' })
  async updateProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProviderConfigDto,
  ) {
    const config = await this.providerWriteRepo.findOne({ where: { id } })
    if (!config) {
      throw new RequestException(
        { code: 'PROVIDER_CONFIG_NOT_FOUND', message: 'Proveedor no encontrado' },
        HttpStatus.NOT_FOUND,
      )
    }

    if (body.isActive !== undefined) config.isActive = body.isActive
    if (body.priority !== undefined) config.priority = body.priority
    if (body.metadata !== undefined) config.metadata = body.metadata

    await this.providerWriteRepo.save(config)
    return { data: config }
  }
}

/** The movement recorded under the key when it is this adjustment; a 409 when it is another one. */
function sameAdjustment(
  movement: Transaction,
  walletId: string,
  type: 'credit' | 'debit',
  amount: number,
): Transaction {
  const expectedType = type === 'credit' ? TransactionType.CREDIT : TransactionType.DEBIT
  const same =
    movement.walletId === walletId &&
    movement.type === expectedType &&
    Math.round(Number(movement.amount) * 100) === Math.round(amount * 100)
  if (!same) {
    throw new RequestException(
      { code: 'IDEMPOTENCY_KEY_CONFLICT', message: 'Key already used by another movement' },
      HttpStatus.CONFLICT,
    )
  }
  return movement
}
