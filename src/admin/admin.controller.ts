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
} from '@nestjs/common'
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, LessThan, MoreThan, In, Between } from 'typeorm'
import { Subscription, SubscriptionStatus } from '../subscription/entities/subscription.entity'
import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import { Wallet, WalletStatus } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { ProviderConfig } from '../provider/entities/providerConfig.entity'
import { Transaction, TransactionType, TransactionStatus } from '../transaction/entities/transaction.entity'
import { AuditService } from '../audit/audit.service'
import { CreditService } from '../credit/credit.service'
import {
  CREDIT_ACTIVATION_REQUEST_STATUSES,
  CreditActivationRequestStatus,
} from '../credit/credit.types'
import { CreditPermissionGuard } from '../credit/guard/credit-permission.guard'
import { RequireCreditPermission } from '../credit/guard/require-credit-permission.decorator'
import { UpdateActivationRequestDto } from '../credit/dto/update-activation-request.dto'

/**
 * Controller admin centralizado para backend-payments.
 *
 * Agrupa endpoints de gestión para el panel administrativo:
 * - Dashboard de suscripciones (expiring, past-due, summary)
 * - Gestión de cobros (pending, failed, retry)
 * - Resumen de wallets (totales, inconsistencias)
 * - Audit log
 */
@ApiTags('Admin')
@Controller('admin')
@UseGuards()
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
  ) {}

  // ============================================
  // Suscripciones
  // ============================================

  @Get('subscriptions')
  @ApiOperation({ summary: 'Listado paginado de suscripciones con filtros' })
  @ApiResponse({ status: 200, description: 'Suscripciones paginadas' })
  async subscriptionsList(
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
    @Query('status') status?: string,
    @Query('planSlug') planSlug?: string,
    @Query('provider') provider?: string,
    @Query('search') search?: string,
    @Query('orderBy') orderBy?: string,
    @Query('order') order?: 'ASC' | 'DESC',
  ) {
    const p = Math.max(1, Number(page) || 1)
    const limit = Math.min(100, Math.max(1, Number(perPage) || 20))
    const skip = (p - 1) * limit

    const qb = this.subscriptionReadRepo.createQueryBuilder('s')

    if (status) qb.andWhere('s.status = :status', { status })
    if (planSlug) qb.andWhere('s.planSlug = :planSlug', { planSlug })
    if (provider) qb.andWhere('s.provider = :provider', { provider })
    if (search) {
      qb.andWhere('(s.brandId::text ILIKE :q OR s.planSlug ILIKE :q)', { q: `%${search}%` })
    }

    const sortField = ['createdAt', 'currentPeriodEnd', 'status', 'planSlug', 'retryCount'].includes(orderBy || '')
      ? `s.${orderBy}` : 's.createdAt'
    const sortOrder = (order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
    qb.orderBy(sortField, sortOrder as 'ASC' | 'DESC')

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

    // Agrupar por plan y estado
    const byPlan: Record<string, Record<string, number>> = {}
    const byStatus: Record<string, number> = {}

    for (const sub of all) {
      // Por plan
      if (!byPlan[sub.planSlug]) byPlan[sub.planSlug] = {}
      byPlan[sub.planSlug][sub.status] = (byPlan[sub.planSlug][sub.status] || 0) + 1

      // Por estado
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
  async extendSubscription(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { days: number; reason?: string; adminUserId?: string },
  ) {
    const sub = await this.subscriptionWriteRepo.findOne({ where: { id } })
    if (!sub) {
      return { error: 'Suscripción no encontrada' }
    }

    const newEnd = new Date(sub.currentPeriodEnd)
    newEnd.setDate(newEnd.getDate() + body.days)

    sub.currentPeriodEnd = newEnd
    sub.nextBillingDate = newEnd
    if (sub.status === SubscriptionStatus.PAST_DUE || sub.status === SubscriptionStatus.EXPIRED) {
      sub.status = SubscriptionStatus.ACTIVE
      sub.retryCount = 0
    }

    await this.subscriptionWriteRepo.save(sub)

    await this.auditService.log(
      body.adminUserId || 'admin',
      'subscription_extended',
      'subscription',
      id,
      { days: body.days, newEnd: newEnd.toISOString() },
      body.reason || `Extendida ${body.days} días manualmente`,
    )

    return { data: sub }
  }

  // ============================================
  // Pagos / Cobros
  // ============================================

  @Get('payments')
  @ApiOperation({ summary: 'Listado paginado de pagos con filtros' })
  @ApiResponse({ status: 200, description: 'Pagos paginados' })
  async paymentsList(
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
    @Query('status') status?: string,
    @Query('provider') provider?: string,
    @Query('purpose') purpose?: string,
    @Query('search') search?: string,
    @Query('orderBy') orderBy?: string,
    @Query('order') order?: 'ASC' | 'DESC',
  ) {
    const p = Math.max(1, Number(page) || 1)
    const limit = Math.min(100, Math.max(1, Number(perPage) || 20))
    const skip = (p - 1) * limit

    const qb = this.paymentReadRepo.createQueryBuilder('p')

    if (status) qb.andWhere('p.status = :status', { status })
    if (provider) qb.andWhere('p.provider = :provider', { provider })
    if (purpose) qb.andWhere('p.purpose = :purpose', { purpose })
    if (search) {
      qb.andWhere('(p.brandId::text ILIKE :q OR p.providerPaymentId ILIKE :q)', { q: `%${search}%` })
    }

    const sortField = ['createdAt', 'amount', 'status', 'provider', 'paidAt'].includes(orderBy || '')
      ? `p.${orderBy}` : 'p.createdAt'
    const sortOrder = (order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
    qb.orderBy(sortField, sortOrder as 'ASC' | 'DESC')

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
  async retryPayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body?: { adminUserId?: string },
  ) {
    const payment = await this.paymentWriteRepo.findOne({ where: { id } })
    if (!payment) {
      return { error: 'Pago no encontrado' }
    }
    if (payment.status !== PaymentStatus.FAILED) {
      return { error: `Pago no está en estado failed (actual: ${payment.status})` }
    }

    payment.status = PaymentStatus.PENDING
    await this.paymentWriteRepo.save(payment)

    await this.auditService.log(
      body?.adminUserId || 'admin',
      'payment_retry',
      'payment',
      id,
      { previousStatus: PaymentStatus.FAILED },
      'Reintento manual de pago',
    )

    return { data: { message: 'Pago marcado para reintento', paymentId: id } }
  }

  @Get('credit/activation-requests')
  @UseGuards(CreditPermissionGuard)
  @RequireCreditPermission('credit:runs')
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
    if (status && !CREDIT_ACTIVATION_REQUEST_STATUSES.includes(status as CreditActivationRequestStatus)) {
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
  @UseGuards(CreditPermissionGuard)
  @RequireCreditPermission('credit:runs')
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
    // Buscar los pagos más recientes con provider=dropi
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

  // ============================================
  // Wallets
  // ============================================

  @Get('wallets')
  @ApiOperation({ summary: 'Listado paginado de wallets con filtros' })
  @ApiResponse({ status: 200, description: 'Wallets paginadas' })
  async walletsList(
    @Query('page') page?: number,
    @Query('perPage') perPage?: number,
    @Query('status') status?: string,
    @Query('provider') provider?: string,
    @Query('currency') currency?: string,
    @Query('search') search?: string,
    @Query('orderBy') orderBy?: string,
    @Query('order') order?: 'ASC' | 'DESC',
  ) {
    const p = Math.max(1, Number(page) || 1)
    const limit = Math.min(100, Math.max(1, Number(perPage) || 20))
    const skip = (p - 1) * limit

    const qb = this.walletReadRepo.createQueryBuilder('w')

    if (status) qb.andWhere('w.status = :status', { status })
    if (provider) qb.andWhere('w.provider = :provider', { provider })
    if (currency) qb.andWhere('w.currency = :currency', { currency })
    if (search) {
      qb.andWhere('(w.brandId::text ILIKE :q OR w.label ILIKE :q)', { q: `%${search}%` })
    }

    const sortField = ['createdAt', 'balance', 'status', 'provider', 'currency'].includes(orderBy || '')
      ? `w.${orderBy}` : 'w.createdAt'
    const sortOrder = (order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
    qb.orderBy(sortField, sortOrder as 'ASC' | 'DESC')

    const [data, total] = await qb.skip(skip).take(limit).getManyAndCount()

    return {
      data,
      count: total,
      meta: { page: p, perPage: limit, total, totalPages: Math.ceil(total / limit) },
    }
  }

  @Post('wallets')
  @ApiOperation({ summary: 'Crear wallet para una marca con balance inicial (Admin)' })
  @ApiResponse({ status: 201, description: 'Wallet creada' })
  async createWallet(
    @Body() body: {
      brandId: string
      userId?: string
      provider: string
      currency: string
      label?: string
      balance?: number
      adminUserId?: string
    },
  ) {
    // Verificar que no exista una wallet con mismo brandId+provider+currency
    const existing = await this.walletReadRepo.findOne({
      where: { brandId: body.brandId, provider: body.provider as any, currency: body.currency },
    })
    if (existing) {
      return { error: `Ya existe una wallet ${body.provider}/${body.currency} para esta marca` }
    }

    const wallet = this.walletWriteRepo.create({
      brandId: body.brandId,
      userId: body.userId || body.brandId,
      provider: body.provider as any,
      currency: body.currency.toUpperCase(),
      label: body.label || null,
      balance: body.balance || 0,
      status: WalletStatus.ACTIVE,
    })

    const saved = await this.walletWriteRepo.save(wallet)

    await this.auditService.log(
      body.adminUserId || 'admin',
      'wallet_created',
      'wallet',
      saved.id,
      { brandId: body.brandId, provider: body.provider, currency: body.currency, balance: body.balance || 0, label: body.label },
      `Wallet ${body.provider}/${body.currency} creada manualmente para marca ${body.brandId}`,
    )

    return { data: saved }
  }

  @Post('wallets/:id/toggle-freeze')
  @ApiOperation({ summary: 'Congelar o descongelar wallet (Admin)' })
  @ApiResponse({ status: 200, description: 'Estado de wallet actualizado' })
  async toggleFreezeWallet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body?: { adminUserId?: string },
  ) {
    const wallet = await this.walletWriteRepo.findOne({ where: { id } })
    if (!wallet) return { error: 'Wallet no encontrada' }
    if (wallet.status === WalletStatus.CLOSED) return { error: 'Wallet cerrada, no se puede modificar' }

    const previousStatus = wallet.status
    wallet.status = wallet.status === WalletStatus.FROZEN ? WalletStatus.ACTIVE : WalletStatus.FROZEN

    await this.walletWriteRepo.save(wallet)

    await this.auditService.log(
      body?.adminUserId || 'admin',
      wallet.status === WalletStatus.FROZEN ? 'wallet_frozen' : 'wallet_unfrozen',
      'wallet',
      id,
      { previousStatus, newStatus: wallet.status },
      `Wallet ${wallet.status === WalletStatus.FROZEN ? 'congelada' : 'descongelada'} manualmente`,
    )

    return { data: wallet }
  }

  @Post('wallets/:id/adjust')
  @ApiOperation({ summary: 'Acreditar o debitar fondos de una wallet (Admin)' })
  @ApiResponse({ status: 200, description: 'Ajuste realizado' })
  async adjustWallet(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      type: 'credit' | 'debit'
      amount: number
      description?: string
      category?: string
      adminUserId?: string
    },
  ) {
    const wallet = await this.walletWriteRepo.findOne({ where: { id } })
    if (!wallet) return { error: 'Wallet no encontrada' }
    if (wallet.status === WalletStatus.CLOSED) return { error: 'Wallet cerrada' }
    if (wallet.status === WalletStatus.FROZEN && body.type === 'debit') {
      return { error: 'Wallet congelada — no se permiten débitos' }
    }

    const amount = Math.abs(Number(body.amount))
    if (!amount || amount <= 0) return { error: 'Monto inválido' }

    const balanceBefore = Number(wallet.balance)
    const balanceAfter = body.type === 'credit'
      ? balanceBefore + amount
      : balanceBefore - amount

    if (body.type === 'debit' && balanceAfter < 0) {
      return { error: `Fondos insuficientes. Balance actual: ${balanceBefore}` }
    }

    // Crear transacción
    const transaction = this.transactionWriteRepo.create({
      walletId: id,
      brandId: wallet.brandId,
      type: body.type === 'credit' ? TransactionType.CREDIT : TransactionType.DEBIT,
      amount,
      balanceBefore,
      balanceAfter,
      status: TransactionStatus.COMPLETED,
      category: body.category || 'admin_adjustment',
      description: body.description || `Ajuste manual (${body.type})`,
      referenceType: 'admin',
      referenceId: body.adminUserId || 'admin',
    })
    await this.transactionWriteRepo.save(transaction)

    // Actualizar balance de la wallet
    wallet.balance = balanceAfter as any
    await this.walletWriteRepo.save(wallet)

    await this.auditService.log(
      body.adminUserId || 'admin',
      body.type === 'credit' ? 'wallet_credit' : 'wallet_debit',
      'wallet',
      id,
      { amount, balanceBefore, balanceAfter, category: body.category, transactionId: transaction.id },
      `${body.type === 'credit' ? 'Crédito' : 'Débito'} manual de ${amount} ${wallet.currency}`,
    )

    return { data: { wallet, transaction } }
  }

  @Get('wallets/summary')
  @ApiOperation({ summary: 'Total de dinero en el sistema por proveedor y moneda' })
  @ApiResponse({ status: 200, description: 'Resumen de wallets' })
  async walletsSummary() {
    const wallets = await this.walletReadRepo.find({
      where: { status: In([WalletStatus.ACTIVE, WalletStatus.FROZEN]) },
    })

    // Agrupar por provider + currency
    const groups: Record<string, { count: number; total: number; currency: string; provider: string }> = {}

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

  // ============================================
  // Audit Log
  // ============================================

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

  // ============================================
  // Proveedores
  // ============================================

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
  async createProvider(
    @Body() body: {
      country: string
      provider: string
      isActive?: boolean
      priority?: number
      metadata?: Record<string, any>
    },
  ) {
    const existing = await this.providerReadRepo.findOne({
      where: { country: body.country.toUpperCase(), provider: body.provider.toLowerCase() },
    })
    if (existing) {
      return { error: `El proveedor ${body.provider} ya existe para ${body.country}` }
    }

    const config = this.providerWriteRepo.create({
      country: body.country.toUpperCase(),
      provider: body.provider.toLowerCase(),
      isActive: body.isActive !== false,
      priority: body.priority || 0,
      metadata: body.metadata || null,
    })

    const saved = await this.providerWriteRepo.save(config)
    return { data: saved }
  }

  @Patch('providers/:id')
  @ApiOperation({ summary: 'Actualizar configuración de proveedor' })
  @ApiResponse({ status: 200, description: 'Proveedor actualizado' })
  async updateProvider(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { isActive?: boolean; priority?: number; metadata?: Record<string, any> },
  ) {
    const config = await this.providerWriteRepo.findOne({ where: { id } })
    if (!config) return { error: 'Proveedor no encontrado' }

    if (body.isActive !== undefined) config.isActive = body.isActive
    if (body.priority !== undefined) config.priority = body.priority
    if (body.metadata !== undefined) config.metadata = body.metadata

    await this.providerWriteRepo.save(config)
    return { data: config }
  }
}
