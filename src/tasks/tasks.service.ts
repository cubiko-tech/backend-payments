import { Injectable } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { InjectRepository } from '@nestjs/typeorm'
import { InjectDataSource } from '@nestjs/typeorm'
import { DataSource, LessThan, In, Between, IsNull, MoreThan, Not, Repository } from 'typeorm'

import { Wallet } from '../wallet/entities/wallet.entity'
import { WalletBalanceSnapshot } from '../wallet/entities/walletBalanceSnapshot.entity'
import { Transaction } from '../transaction/entities/transaction.entity'
import { Payment, PaymentStatus } from '../payment/entities/payment.entity'
import {
  Subscription,
  SubscriptionProvider,
  SubscriptionStatus,
  LIVE_SUBSCRIPTION_STATUSES,
} from '../subscription/entities/subscription.entity'
import { SubscriptionEvent, SubscriptionEventType } from '../subscription/entities/subscriptionEvent.entity'
import { WebhookEvent } from '../webhook/entities/webhookEvent.entity'
import { ConfioSubscriptionWebhookService } from '../webhook/confio-subscription-webhook.service'
import { WalletService } from '../wallet/wallet.service'
import { AuditService } from '../audit/audit.service'
import { ProviderFactory } from '../provider/provider.factory'
import { EventBusService } from '../event-bus/event-bus.service'
import { ClientRolesService } from '../client/client-roles.service'
import { downgradeBrandToFree, freePlanSlug } from '../client/plan-downgrade.util'
import { CheckoutService } from '../checkout/checkout.service'
import { logger } from '../shared/logger/logger'

/**
 * Los crons del servicio. Qué hace este archivo con `SubscriptionStatus.PENDING`
 * —el alta que todavía no confirmó, **de prueba o paga desde el 2026-09-02**: la
 * de prueba también nace ahí y espera el `TRIALING` de ConfioPagos—: **nada,
 * salvo excluirlo a mano donde se reparte acceso**. Re-verificado al hacer ese
 * cambio: las siete consultas siguen enumerando estados y ninguna lo nombra. El criterio se declara en dos lugares, y hacen
 * falta los dos:
 *
 * 1. **Las siete consultas** ENUMERAN los estados que toman y ninguna lo nombra —
 *    `processTrialConversions` filtra `TRIAL`; `processSubscriptionRenewals`
 *    `In([ACTIVE, PAST_DUE])`; `retryFailedPayments` y `expireSubscriptions`
 *    `PAST_DUE`; `expireCancelledSubscriptions` y `sendExpirationWarnings` enumeran
 *    `TRIAL`/`ACTIVE`/`PAST_DUE`. Un estado nuevo entra sólo si alguien lo agrega a
 *    mano, que es como tiene que ser.
 * 2. **Los predicados sobre una fila RELEÍDA**, que las consultas no cubren: el
 *    reponedor `reponerPlanSiSigueVigente` decide entitlement sobre lo que la
 *    relectura devuelve, no sobre lo que la consulta filtró. Ahí el criterio es
 *    `LIVE_SUBSCRIPTION_STATUSES` (positivo) y no `!TERMINAL_…`: la negación
 *    admitía `pending` y le regalaba el plan pago. Ver el ⚠️ de ese método.
 *
 * ⚠️ DINERO — por qué `pending` no puede entrar a las dos primeras:
 * `processSubscriptionRenewals` y `retryFailedPayments` emiten un link de cobro REAL
 * (`issueExternalCharge`). Una fila que todavía no aceptó su link INICIAL no puede
 * recibir un segundo riel de cobro en paralelo: serían dos links vivos para el mismo
 * primer período. El guard del loop de `processSubscriptionRenewals`
 * (`sub.status === ACTIVE` para `confio`) es la segunda línea de defensa, y las dos
 * están fijadas por «ningún barrido que emite cobro incluye `pending`» en
 * `tasks.service.spec.ts`.
 *
 * ⚠️ Esa invariante vale mientras la fila SIGA en `pending`, y hay un camino que la
 * saca — es DEUDA ABIERTA del productor, no algo cerrado acá: la rama de cobro no
 * exitoso de `ConfioSubscriptionWebhookService` (`confio-subscription-webhook.service.ts`)
 * no filtra por estado y escribe `past_due`. Una fila `pending` que reciba ese
 * webhook cae en la consulta de `retryFailedPayments`, que barre `PAST_DUE` +
 * `autoRenew` SIN el guard `status === ACTIVE` que sí tiene
 * `processSubscriptionRenewals`, y emitiría un segundo link con el inicial
 * posiblemente vivo. Cerrarlo es del productor (`alta-paga-sin-prueba`), que es
 * quien puede decidir si la rama filtra por estado o si el guard se replica acá.
 *
 * ⚠️ DEUDA VERIFICADA, NO SE ARREGLA ACÁ (también del productor): la baja de
 * `SubscriptionService.cancel` sobre una fila `pending` le sella `accessEndsAt` y
 * ningún cron la consume después. El detalle vive PEGADO a ese código
 * (`subscription.service.ts`, el guard de `accessEndsAt`), que es donde lo va a leer
 * quien lo toque; acá sólo queda el puntero.
 */
@Injectable()
export class TasksService {
  private readonly MAX_RETRY = parseInt(process.env.MAX_PAYMENT_RETRY_COUNT || '3')
  /** Cuántas altas sin confirmar se consultan por pasada. Cota dura, no sugerencia. */
  private readonly MAX_REPESCA = parseInt(process.env.MAX_PENDING_CONFIRMATIONS || '50')
  /**
   * Ventana de repesca, en días. El link de aceptación de ConfioPagos vence a los 7
   * por default, así que después de eso no hay nada que confirmar y seguir
   * preguntando por esas filas sería gastar llamadas para siempre.
   */
  private readonly DIAS_DE_REPESCA = parseInt(process.env.PENDING_CONFIRMATION_DAYS || '8')
  /** Candado de solapamiento: `@Cron` de Nest no impide que dos pasadas se pisen. */
  private repescaEnCurso = false
  private readonly CHECKOUT_EXPIRY_HOURS = parseInt(process.env.CHECKOUT_EXPIRY_HOURS || '24')
  private readonly BILLING_PERIOD_DAYS = parseInt(process.env.BILLING_PERIOD_DAYS || '30')

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

  /** Proveedores externos que cobran con link de pago (no wallet interna). */
  private isExternalProvider(provider: string): boolean {
    return provider === 'confio' || provider === 'stripe' || provider === 'mercadopago' || provider === 'dropi'
  }

  /**
   * Emitir un cobro a un proveedor externo (ConfioPagos): genera un link de
   * pago vía checkout y notifica al usuario. Deja la suscripción en past_due
   * a la espera de que el usuario pague (el webhook la reactiva). `isRetry`
   * incrementa el contador para que expireSubscriptions degrade tras MAX intentos.
   */
  private async issueExternalCharge(sub: Subscription, isRetry: boolean) {
    try {
      const result = await this.checkoutService.processCheckout({
        brandId: sub.brandId,
        userId: sub.userId,
        purpose: 'plan_purchase',
        provider: sub.provider as any,
        planSlug: sub.planSlug,
        // Renovación: resuelve por país como el alta pero es INDULGENTE — si no
        // puede (marca no consultable, sin país, plan sin fila) cae al precio
        // legacy en vez de fallar, porque un fallo acá deja la suscripción
        // `past_due` sin link de pago. Ver `CheckoutService.renewalPlanPrice`.
        renewal: true,
      })

      const previousStatus = sub.status
      sub.status = SubscriptionStatus.PAST_DUE
      if (isRetry) sub.retryCount = (sub.retryCount || 0) + 1
      await this.subscriptionRepo.save(sub)

      await this.subscriptionEventRepo.save(
        this.subscriptionEventRepo.create({
          subscriptionId: sub.id,
          eventType: SubscriptionEventType.PAYMENT_FAILED,
          fromStatus: previousStatus,
          toStatus: SubscriptionStatus.PAST_DUE,
          triggeredBy: 'system',
          paymentId: result.paymentId,
          reason: isRetry
            ? `Reintento de cobro ${sub.provider} (${sub.retryCount}/${this.MAX_RETRY})`
            : `Link de cobro ${sub.provider} emitido`,
        }),
      )

      // Notificar al usuario el link de pago (backend-processes envía email/push).
      await this.eventBus.publishNotification({
        brandId: sub.brandId,
        userId: sub.userId,
        type: 'payment_link',
        subject: `Completa el pago de tu plan ${sub.planSlug}`,
        metadata: {
          checkoutUrl: result.checkoutUrl || '',
          planSlug: sub.planSlug,
          paymentId: result.paymentId,
        },
      })

      logger.log('info', `[CRON] Link de cobro ${sub.provider} emitido para brand ${sub.brandId}: ${result.checkoutUrl}`)
    } catch (error) {
      logger.log('error', `[CRON] Error emitiendo cobro externo ${sub.id}: ${error.message}`)
      // Marcar past_due igual para que el ciclo de expiración avance.
      sub.status = SubscriptionStatus.PAST_DUE
      if (isRetry) sub.retryCount = (sub.retryCount || 0) + 1
      await this.subscriptionRepo.save(sub)
    }
  }

  // =============================================================
  // 0. Convertir trials vencidos (cada hora)
  //    Trial → primer cobro si hay método de pago; si no, degradar a free.
  // =============================================================
  @Cron(CronExpression.EVERY_HOUR)
  async processTrialConversions() {
    const now = new Date()
    const trials = await this.subscriptionRepo.find({
      where: {
        status: SubscriptionStatus.TRIAL,
        nextBillingDate: LessThan(now),
        // ⚠️ DINERO. La baja (`SubscriptionService.cancel`) ya no mueve la fila a
        // `cancelled`: apaga `autoRenew` y la deja en su estado vigente, así que un
        // trial dado de baja SIGUE siendo `trial` y sin este filtro volvería a caer
        // acá. Si además es `provider = 'wallet'` con `walletId`, `renewFromWallet`
        // debitaría la wallet de alguien que ya se dio de baja. Hoy es un no-op
        // (ninguna fila viva combina `trial` con `autoRenew = false`); el filtro es
        // el candado para mañana.
        autoRenew: true,
      },
    })

    if (trials.length === 0) return
    logger.log('info', `[CRON] processTrialConversions: ${trials.length} trials vencidos`)

    let converted = 0
    let downgraded = 0
    let linked = 0
    let skipped = 0
    for (const sub of trials) {
      // Wallet interna: cobrar si hay saldo; sin walletId (trial sin tarjeta) → degradar a free.
      if (sub.provider === 'wallet') {
        if (!sub.walletId) {
          if (await this.endTrialWithoutPayment(sub)) downgraded++
          continue
        }
        try {
          await this.renewFromWallet(sub)
          converted++
        } catch (error) {
          logger.log('error', `[CRON] Error cobrando trial wallet ${sub.id}: ${error.message}`)
          await this.handleRenewalFailure(sub)
        }
        continue
      }

      // El alta ya emitió el único link inicial de esta fila: emitir otro abriría un riel de
      // cobro paralelo al de la suscripción recurrente. Se discrimina por el marcador y NO por
      // `providerSubscriptionId`. La fila queda en TRIAL a propósito: la degradación por
      // `trialEnd` es de otra tarea.
      if (sub.initialPaymentLinkIssuedAt) {
        skipped++
        continue
      }

      // Proveedor externo (ConfioPagos): emitir link de pago y notificar.
      // El webhook reactiva la suscripción cuando el usuario paga.
      await this.issueExternalCharge(sub, false)
      linked++
    }

    logger.log(
      'info',
      `[CRON] processTrialConversions: ${converted} cobrados, ${linked} con link emitido, ` +
        `${downgraded} degradados a ${freePlanSlug()}, ` +
        `${skipped} salteados: link inicial ya emitido`,
    )
  }

  // =============================================================
  // 1.b Repescar las altas que nunca confirmamos (cada 5 minutos)
  // =============================================================
  /**
   * El que pagó y NUNCA volvió a la pantalla también consigue su plan.
   *
   * El front confirma al volver del pago; esto cubre al que cerró la pestaña, pagó
   * desde otro dispositivo o se quedó sin internet justo ahí. Es la segunda pata de
   * «no se depende del webhook» (regla de la épica 002 desde el 2026-09-02).
   *
   * ⚠️ DINERO — LO QUE ESTE BARRIDO NO HACE: no emite ningún cobro ni ningún link.
   * Es el único que toca filas `pending`, y la invariante declarada en el docblock
   * del archivo («ningún barrido que emite cobro incluye `pending`») sigue intacta
   * justamente porque éste sólo LEE del proveedor y otorga. Si algún día alguien le
   * agrega un `issueExternalCharge`, se abre un segundo riel de cobro en paralelo al
   * link inicial que esa fila ya tiene vivo.
   *
   * La fila que todavía no aceptó se deja como está: no se marca, no se cuenta como
   * fallo y no se degrada. El comprador puede aceptar mañana, dentro de la ventana
   * del link.
   */
  @Cron('*/5 * * * *')
  async confirmarAltasPendientes() {
    // Las pasadas no se solapan: cada fila es una llamada HTTP al proveedor con 30 s
    // de timeout, así que una pasada lenta puede seguir viva cuando entra la
    // siguiente, y dos pasadas sobre las mismas filas duplican el tráfico contra
    // ConfioPagos sin ganar nada.
    if (this.repescaEnCurso) {
      logger.log('info', '[CRON] confirmarAltasPendientes: la pasada anterior sigue en curso, se saltea')
      return
    }
    this.repescaEnCurso = true

    try {
      const desde = new Date(Date.now() - this.DIAS_DE_REPESCA * 24 * 60 * 60 * 1000)
      const pendientes = await this.subscriptionRepo.find({
        where: {
          // ENUMERA el estado, como las otras siete consultas del archivo: `pending`
          // es el único que espera confirmación. Una fila viva o terminal no se toca.
          status: SubscriptionStatus.PENDING,
          provider: SubscriptionProvider.CONFIO,
          // Sin suscripción del otro lado no hay nada que consultar.
          providerSubscriptionId: Not(IsNull()),
          // Pasada la ventana del link no queda nada por confirmar: se deja de
          // preguntar en vez de arrastrar esas filas para siempre.
          initialPaymentLinkIssuedAt: MoreThan(desde),
        },
        // La más vieja primero: con más altas que cota, ninguna queda postergada
        // indefinidamente entre pasadas.
        order: { updatedAt: 'ASC' },
        take: this.MAX_REPESCA,
      })

      if (pendientes.length === 0) return

      let otorgadas = 0
      let sinConfirmar = 0
      let fallidas = 0
      for (const sub of pendientes) {
        try {
          // La regla de qué se otorga NO está acá: es la misma que aplica el webhook.
          const { resultado } = await this.confioWebhook.confirmarContraElProveedor(sub)
          if (resultado === 'otorgada') otorgadas++
          else if (resultado === 'sin_confirmar') sinConfirmar++
        } catch (error) {
          // Una fila que falla —típicamente porque `backend-roles` rechazó el
          // movimiento— NO puede cortar la pasada: las demás siguen. La próxima
          // vuelve a intentarla, que es el mismo criterio de `expireSubscriptions`.
          fallidas++
          logger.log('error', `[CRON] confirmarAltasPendientes: ${sub.id} falló: ${error?.message}`)
        }
      }

      logger.log(
        'info',
        `[CRON] confirmarAltasPendientes: ${pendientes.length} revisadas, ${otorgadas} otorgadas, ` +
          `${sinConfirmar} todavía sin aceptar, ${fallidas} con error`,
      )
    } finally {
      this.repescaEnCurso = false
    }
  }

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
        } else if (sub.provider === 'confio' && sub.status === SubscriptionStatus.ACTIVE) {
          // ConfioPagos one-shot: re-emitir link de cobro cada período.
          await this.issueExternalCharge(sub, false)
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
        } else if (sub.provider === 'confio') {
          // ConfioPagos: re-emitir el link de cobro (cuenta como reintento).
          await this.issueExternalCharge(sub, true)
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
  // 2b. Reconciliar pagos Confío pendientes (cada 5 min)
  //     Red de seguridad: si el webhook se perdió y el usuario no volvió,
  //     consulta el estado real y completa los pagos ya pagados.
  // =============================================================
  @Cron('*/5 * * * *')
  async reconcileExternalPayments() {
    const cutoff = new Date(Date.now() - 2 * 60 * 1000) // pagos de más de 2 min
    const pending = await this.paymentRepo.find({
      where: {
        provider: 'confio' as any,
        status: PaymentStatus.PENDING,
        createdAt: LessThan(cutoff),
      },
    })

    if (pending.length === 0) return

    let completed = 0
    for (const p of pending) {
      if (!p.providerPaymentId) continue
      try {
        const real = await this.providerFactory.getProvider('confio').getPaymentStatus(p.providerPaymentId)
        if (real.status === 'completed') {
          await this.checkoutService.completeExternalPayment(p.id, { source: 'cron-reconcile' })
          completed++
        }
      } catch (error) {
        logger.log('warn', `[CRON] reconcileExternalPayments: error con pago ${p.id}: ${error.message}`)
      }
    }

    logger.log('info', `[CRON] reconcileExternalPayments: ${pending.length} revisados, ${completed} completados`)
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
    let rechazadas = 0
    for (const sub of expired) {
      if (sub.retryCount < this.MAX_RETRY) continue

      // La degradación va PRIMERO y nada se vence si roles la rechaza: marcar la
      // fila vencida sin haber movido el acceso dejaría a la marca con el plan
      // pago puesto y sin nadie que vuelva a intentarlo. La contracara es que una
      // caída de backend-roles se ve como «suscripciones que no vencen»: la fila
      // queda en `past_due` con los reintentos agotados y la pasada siguiente del
      // cron la vuelve a tomar (retirar y asignar son idempotentes del otro lado).
      if (!(await this.degradarEnRoles(sub))) {
        await this.detenerCobroRecurrente(sub)
        rechazadas++
        continue
      }

      // Compare-and-set: sólo vence la fila que TODAVÍA está en `past_due`. Los
      // `@Cron` de Nest no impiden que dos pasadas se solapen y la degradación de
      // arriba es HTTP con 10 s de timeout, así que la ventana entre el `find` y
      // esta escritura es ancha; sin el predicado de estado las dos pasadas
      // escribirían `expired` y su fila de historial, y la aceptación 4 pide
      // exactamente una. `update` y no `save` también evita reescribir columnas
      // con la copia vieja que se leyó antes de la llamada a roles.
      //
      // ⚠️ DINERO: sin apagar `autoRenew` la fila seguiría siendo elegible para
      // `processSubscriptionRenewals` y `retryFailedPayments`, que emiten cobro.
      //
      // `accessEndsAt: null` porque este cron se queda además con las filas de la
      // intersección (baja sellada + mora agotada), que `expireCancelledSubscriptions`
      // le cede: sin nular, la fila terminal conservaría la fecha de corte de una baja
      // ya consumada y rompería la invariante de la entidad («no nula ⇔ baja PENDIENTE»).
      const vencida = await this.subscriptionRepo.update(
        { id: sub.id, status: SubscriptionStatus.PAST_DUE },
        { status: SubscriptionStatus.EXPIRED, autoRenew: false, accessEndsAt: null },
      )
      if (!vencida.affected) {
        logger.log('info', `[CRON] Suscripción ${sub.id} ya no estaba en past_due: no se vence dos veces`)
        continue
      }

      await this.subscriptionEventRepo.save(
        this.subscriptionEventRepo.create({
          subscriptionId: sub.id,
          eventType: SubscriptionEventType.EXPIRED,
          fromStatus: SubscriptionStatus.PAST_DUE,
          toStatus: SubscriptionStatus.EXPIRED,
          triggeredBy: 'system',
          reason: `Reintentos de pago agotados (${this.MAX_RETRY} intentos)`,
        }),
      )

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

    // Las salteadas se cuentan aparte: sin esta línea una caída de backend-roles
    // se lee como «0 suscripciones expiradas», que es lo mismo que un día sin
    // morosos y no deja señal de que hay filas atascadas.
    if (rechazadas > 0) {
      logger.log(
        'error',
        `[CRON] expireSubscriptions: ${rechazadas} sin vencer, backend-roles rechazó la degradación`,
      )
    }
  }

  // =============================================================
  // 4b. Retirar el plan cuando vence el acceso ya pagado (cada hora)
  // =============================================================
  /**
   * Cierre de las bajas cuya fecha de corte ya pasó (épica 002,
   * `retiro-de-plan-al-vencer-el-periodo`).
   *
   * Desde el corte diferido, `SubscriptionService.cancel` apaga la renovación y
   * sella `accessEndsAt` pero YA NO mueve el `status`: la fila sigue viva
   * —`trial`/`active`/`past_due`— con el plan pago puesto hasta esa fecha. Esa
   * columna tenía sólo escritores; este cron es su ÚNICO lector y el que consuma
   * la baja: degrada en roles y recién ahí escribe el estado terminal.
   *
   * ⚠️ OPERACIÓN: para volver a dar de alta una marca cerrada por acá va un alta
   * nueva por checkout, NUNCA `POST /subscription/reactivate`. Ese endpoint gatea
   * por el sello `cancelledAt`, que este cron deja puesto, así que las filas que
   * cierra pasarían el gate: por eso `reactivate` rechaza además todo estado
   * terminal (`SUBSCRIPTION_CLOSED`). Sin ese rechazo, la fila volvía a `active`
   * sin pago y sin reponer el plan en roles —una suscripción viva sobre una marca
   * en `free`, y otra vez elegible para el cobro de `processSubscriptionRenewals`—.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireCancelledSubscriptions() {
    // Un solo instante para toda la pasada: es el que decide qué filas entran Y el
    // que vuelve a exigir el compare-and-set más abajo, así que no pueden ser dos
    // relojes distintos.
    const ahora = new Date()

    // `LessThan` excluye NULL en SQL, así que la consulta toma exactamente las
    // filas con baja PENDIENTE ya vencida. La cota es parte del contrato y no una
    // optimización: la degradación es HTTP con 10 s de timeout y sin `take` una
    // pasada lenta se solaparía consigo misma. El orden por fecha hace que un
    // backlog se drene por antigüedad y no al azar.
    //
    // Las dos ramas son el DUEÑO ÚNICO DEL RIEL DE MORA hecho SQL: la mora con los
    // reintentos agotados es de `expireSubscriptions` (ver el guard del loop) y por
    // eso no entra acá. Filtrarla recién en el loop la dejaba consumiendo la cota de
    // 200 pasada tras pasada —`order: accessEndsAt ASC` le da además la prioridad
    // más alta—, y con suficientes filas trabadas ninguna baja NUEVA se degradaba
    // nunca: la marca conservaba su plan pago indefinidamente.
    const bajaVencida = { autoRenew: false, accessEndsAt: LessThan(ahora) }
    const vencidas = await this.subscriptionRepo.find({
      where: [
        { status: In([SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE]), ...bajaVencida },
        { status: SubscriptionStatus.PAST_DUE, retryCount: LessThan(this.MAX_RETRY), ...bajaVencida },
      ],
      order: { accessEndsAt: 'ASC' },
      take: 200,
    })

    let cerradas = 0
    let rechazadas = 0
    for (const sub of vencidas) {
      // DUEÑO ÚNICO DEL RIEL DE MORA, repetido acá pegado a la escritura. Una fila
      // dada de baja MIENTRAS estaba en mora cae en las dos consultas horarias:
      // `expireSubscriptions` toma TODO `past_due` y filtra por `retryCount` dentro
      // del loop. Los dos crons disparan al minuto 0 y el compare-and-set impide la
      // doble escritura, pero el estado terminal y el `SubscriptionEvent` quedarían
      // a suerte —`expired` por un lado, `cancelled` por el otro— para el MISMO
      // hecho. Gana `expireSubscriptions`: los reintentos agotados son la causa de
      // negocio más específica y ese cron ya existía.
      //
      // No es redundante con la rama `past_due` de la consulta: allá la regla evita
      // que estas filas gasten la cota; acá evita que una llegue a degradarse por
      // otro camino de lectura. La regla vale para el WRITE, y vive con él.
      if (sub.status === SubscriptionStatus.PAST_DUE && sub.retryCount >= this.MAX_RETRY) continue

      // La degradación va PRIMERO, igual que en los otros dos disparadores: si
      // roles la rechaza no se escribe NADA local y la fila —que conserva su
      // `accessEndsAt`— la retoma la pasada siguiente. Retirar y asignar son
      // idempotentes del otro lado (`plan-downgrade.util.ts` §3).
      //
      // NO se llama a `detenerCobroRecurrente`: toda fila que esta consulta
      // devuelve ya tiene `autoRenew: false`. Ese helper es del riel `past_due`.
      if (!(await this.degradarEnRoles(sub))) {
        rechazadas++
        continue
      }

      // Se lee ANTES del compare-and-set, que borra la columna.
      const finDeAcceso = sub.accessEndsAt

      // Compare-and-set contra el estado VIGENTE (no un `active` hardcodeado: la
      // baja pudo sellarse en prueba o en mora) y contra `autoRenew: false`: si
      // entre el `find` y esta escritura alguien reactivó o recompró la fila, ese
      // camino gana y acá no se cierra nada. `accessEndsAt: null` mantiene la
      // invariante de la entidad: no nula ⇔ baja PENDIENTE, y ésta se consumó.
      //
      // `accessEndsAt: LessThan(ahora)` —el MISMO predicado de la consulta— cierra
      // el hueco de una baja DISTINTA: entre el `find` y esta escritura la fila pudo
      // reactivarse y volver a darse de baja con una fecha de corte FUTURA, y ese
      // trío `{id, status, autoRenew:false}` es idéntico al que se leyó. Sin esta
      // cuarta condición la pasada vieja cerraba un acceso pagado todavía vigente y
      // le borraba la fecha.
      const cerrada = await this.subscriptionRepo.update(
        { id: sub.id, status: sub.status, autoRenew: false, accessEndsAt: LessThan(ahora) },
        { status: SubscriptionStatus.CANCELLED, accessEndsAt: null },
      )
      if (!cerrada.affected) {
        await this.reponerPlanSiSigueVigente(sub, ahora)
        continue
      }

      // La traza es el ÚNICO rastro que queda de hasta cuándo corrió el acceso
      // pagado: la columna se acaba de borrar y `cancelledAt` es la fecha de la
      // BAJA, no la del corte. Forma espejo de la que estampa
      // `SubscriptionService.cancel`.
      await this.subscriptionEventRepo.save(
        this.subscriptionEventRepo.create({
          subscriptionId: sub.id,
          eventType: SubscriptionEventType.EXPIRED,
          fromStatus: sub.status,
          toStatus: SubscriptionStatus.CANCELLED,
          triggeredBy: 'system',
          reason: `Fin del acceso pagado tras la baja — degradado a ${freePlanSlug()}`,
          metadata: {
            event: 'subscription.access_ended',
            accessEndsAt: finDeAcceso ? finDeAcceso.toISOString() : null,
            brandId: sub.brandId,
            planSlug: sub.planSlug,
          },
        }),
      )

      // Redundancia para el consumer de backend-roles, espejo de expireSubscriptions.
      this.eventBus.publishSubscriptionExpired({
        brandId: sub.brandId,
        subscriptionId: sub.id,
        planSlug: sub.planSlug,
      })

      // El aviso «tu plan venció» va DESPUÉS del compare-and-set para que sólo
      // notifique la pasada que realmente cerró la fila. Este cron es su dueño
      // para las filas con baja sellada: ver el comentario en
      // `sendExpirationWarnings`, que le cedió el hito de 0 días.
      await this.eventBus.notifySubscriptionExpired(sub.brandId, sub.planSlug)

      logger.log('info', `[CRON] Acceso pagado terminado, marca en ${freePlanSlug()}: brandId=${sub.brandId}`)
      cerradas++
    }

    if (cerradas > 0) {
      logger.log('info', `[CRON] expireCancelledSubscriptions: ${cerradas} suscripciones cerradas`)
    }

    // Sin esta línea una caída de backend-roles se lee como «0 filas cerradas»,
    // que es lo mismo que un día sin bajas vencidas. Mismo razonamiento que en
    // `expireSubscriptions`.
    if (rechazadas > 0) {
      logger.log(
        'error',
        `[CRON] expireCancelledSubscriptions: ${rechazadas} sin cerrar, backend-roles rechazó la degradación`,
      )
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

      // Dos ramas porque hay dos fuentes posibles para la fecha del aviso, y la
      // buena depende de si la fila tiene una baja sellada:
      //  - Con `accessEndsAt` (baja PENDIENTE) esa columna ES el fin del servicio y
      //    manda. Agendar por `currentPeriodEnd` avisaba tarde a una fila en prueba
      //    —ahí el corte es `trialEnd`, otro día— y el filtro `active` directamente
      //    la dejaba afuera: desde el corte diferido la baja ya no mueve el `status`,
      //    así que la fila se queda en `trial`/`past_due`.
      //  - Sin ella se conserva el criterio de siempre (`currentPeriodEnd` sobre una
      //    fila `active` que no auto-renueva). `IsNull()` mantiene las dos ramas
      //    DISJUNTAS: ninguna fila puede recibir el mismo aviso dos veces.
      const porAccesoSellado = {
        status: In([
          SubscriptionStatus.TRIAL,
          SubscriptionStatus.ACTIVE,
          SubscriptionStatus.PAST_DUE,
        ]),
        autoRenew: false, // Solo avisar a los que NO auto-renuevan
        accessEndsAt: Between(rangeStart, rangeEnd),
      }

      const porPeriodo = {
        status: In([SubscriptionStatus.ACTIVE]),
        autoRenew: false,
        accessEndsAt: IsNull(),
        currentPeriodEnd: Between(rangeStart, rangeEnd),
      }

      // El hito de 0 días («tu plan venció») se le CEDE a
      // `expireCancelledSubscriptions` en la rama de la baja sellada: ese cron corre
      // en punto, así que toda fila cuyo `accessEndsAt` caiga entre 00:00 y 09:00
      // llega acá ya `cancelled` y con la columna en NULL — no matchearía NI esta
      // rama (fecha nula) NI la de `currentPeriodEnd` (pide `active` + `IsNull`), y
      // el usuario nunca se enteraría. Ahora avisa él, en la HORA real del corte.
      // Balance por población — selladas: 1 aviso antes (9am) y 1 ahora (hora del
      // corte); sin sellar (rama 2): sin cambio, conservan su aviso de día 0 porque
      // ese cron no las toca (`LessThan` excluye NULL); `past_due` con reintentos
      // agotados: 0 antes y 0 ahora (a las 9 ya están en `expired`, fuera de la rama 1).
      const subscriptions = await this.subscriptionRepo.find({
        where: days === 0 ? [porPeriodo] : [porAccesoSellado, porPeriodo],
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
   * Degradación a `free` de una fila tomada por un cron, con la guarda de fila
   * incompleta que el webhook ya tiene en `efectoRoles`.
   *
   * Devuelve si el acceso quedó donde tiene que quedar, o sea si el llamador
   * puede seguir y escribir el estado terminal.
   *
   * Sin `brandId` o sin `planSlug` no hay movimiento posible: los dos van al path
   * de roles (`/v1/brand/{id}/plan/slug/{slug}`) y un segmento vacío da 404 →
   * `false`, indistinguible de un canal caído, así que la fila quedaría sin
   * vencer PARA SIEMPRE. Se registra el error y se deja seguir, que es lo mismo
   * que hace el webhook (`efectoRoles` devuelve `undefined` y el efecto local se
   * aplica igual): no hay acceso pago que retirar si no se sabe de quién.
   */
  private async degradarEnRoles(sub: Subscription): Promise<boolean> {
    if (!sub.brandId || !sub.planSlug) {
      logger.log(
        'error',
        `[CRON] Suscripción ${sub.id} sin brandId/planSlug: no se degrada en roles ` +
          `(brand=${sub.brandId} plan=${sub.planSlug})`,
      )

      return true
    }

    return downgradeBrandToFree(this.clientRoles, sub.brandId, sub.planSlug)
  }

  /**
   * Repara la ventana entre la degradación en roles y el compare-and-set que no
   * cerró la fila.
   *
   * ⚠️ DINERO / ACCESO. `degradarEnRoles` corre sobre la copia leída al principio
   * de la pasada y es HTTP con 10 s de timeout; el compare-and-set va después. Si
   * en ese rato alguien reactivó o recompró la suscripción, roles YA se quedó sin
   * el plan pago y con `free` encima, el CAS no afecta filas y —sin esto— el cron
   * seguía de largo: una marca que paga, viva y `active` en la base local, sentada
   * en `free` del otro lado, sin traza y sin ningún cron que la retome (la fila ya
   * no matchea la consulta).
   *
   * NO se repone a ciegas: el caso ABRUMADORAMENTE más común de `affected: 0` es
   * la pasada solapada que ya cerró la fila legítimamente, y reponer ahí sería
   * regalarle el plan pago a una marca dada de baja. Por eso se relee la fila y
   * sólo se repone si sigue con derecho: está en un estado VIVO y o bien volvió a
   * renovarse, o tiene una fecha de corte todavía futura.
   *
   * ⚠️ El criterio de estado es POSITIVO (`LIVE_SUBSCRIPTION_STATUSES`) y no la
   * negación de `TERMINAL_SUBSCRIPTION_STATUSES`, que es lo que era: los dos
   * conjuntos dejaron de ser complementarios cuando entró `pending` y la negación
   * le concedía el plan PAGO a una fila que no pagó nada. El camino no es teórico
   * —el índice único por `brandId` lo hace el más probable—: el alta paga que entra
   * en esta misma ventana TOCTOU REUSA la fila y la deja `pending` con `autoRenew:
   * true`, así que la relectura veía exactamente eso. Enumerar es también lo que
   * hace que un estado futuro tenga que sumarse a mano en vez de colarse.
   *
   * El `expiresAt` sale de `currentPeriodEnd` de la fila RELEÍDA —el período que
   * hoy tiene paga—, igual que `checkout.assignPlanInRoles`. Si roles rechaza,
   * queda el log de error: no hay nada local que revertir, la fila ya es correcta.
   */
  private async reponerPlanSiSigueVigente(sub: Subscription, ahora: Date): Promise<void> {
    logger.log(
      'error',
      `[CRON] La suscripción ${sub.id} cambió mientras se degradaba en roles: el cierre no se aplicó`,
    )

    if (!sub.brandId || !sub.planSlug || sub.planSlug === freePlanSlug()) return

    const vigente = await this.subscriptionRepo.findOne({ where: { id: sub.id } })
    const sigueConDerecho =
      !!vigente &&
      LIVE_SUBSCRIPTION_STATUSES.includes(vigente.status) &&
      (vigente.autoRenew || (!!vigente.accessEndsAt && vigente.accessEndsAt > ahora))
    if (!sigueConDerecho) return

    const repuesto = await this.clientRoles.assignPlanToBrand(
      vigente.brandId,
      vigente.planSlug,
      vigente.currentPeriodEnd,
    )
    logger.log(
      repuesto ? 'info' : 'error',
      `[CRON] Plan ${vigente.planSlug} ${repuesto ? 'repuesto' : 'NO repuesto'} en backend-roles ` +
        `tras el cierre abortado: brandId=${vigente.brandId}`,
    )
  }

  /**
   * Apaga la renovación de una fila que NO se pudo degradar en roles.
   *
   * ⚠️ DINERO: la fila se queda en `past_due` a propósito para que la pasada
   * siguiente reintente la degradación, pero con `autoRenew` encendido y
   * `nextBillingDate` vencido sigue siendo elegible para
   * `processSubscriptionRenewals` y `retryFailedPayments` —los dos filtran por
   * `autoRenew: true`—, que para `provider === 'wallet'` DEBITAN la wallet y,
   * vía `extendSubscriptionPeriod`, hasta reactivan la suscripción. Mientras
   * durara la caída de backend-roles se estaría cobrando algo que el negocio ya
   * decidió matar. Apagar la renovación corta el riel de COBRO y no toca el
   * acceso, que lo sigue decidiendo roles; es lo único que se persiste acá.
   *
   * `update` acotado a la columna y no `save`: la entidad se leyó antes de la
   * llamada HTTP y un `save` reescribiría todas sus columnas con esa copia vieja.
   */
  private async detenerCobroRecurrente(sub: Subscription): Promise<void> {
    if (!sub.autoRenew) return

    await this.subscriptionRepo.update({ id: sub.id }, { autoRenew: false })
    sub.autoRenew = false
    logger.log('info', `[CRON] Renovación apagada mientras se reintenta la degradación: ${sub.id}`)
  }

  /**
   * Terminar un trial vencido que no tiene método de pago: degradar a free.
   *
   * Devuelve si la degradación se concretó. Como en `expireSubscriptions`, el
   * movimiento en roles va ANTES de tocar la fila: si roles lo rechaza no se
   * escribe nada, la suscripción sigue en `TRIAL` con `nextBillingDate` vencido y
   * el cron horario la retoma.
   */
  private async endTrialWithoutPayment(sub: Subscription): Promise<boolean> {
    if (!(await this.degradarEnRoles(sub))) return false

    // Compare-and-set contra `trial`, por el mismo motivo que en
    // `expireSubscriptions`: dos pasadas solapadas del cron horario no pueden
    // escribir dos veces el fin del trial ni dos filas de historial.
    const terminado = await this.subscriptionRepo.update(
      { id: sub.id, status: SubscriptionStatus.TRIAL },
      { status: SubscriptionStatus.EXPIRED, autoRenew: false },
    )
    if (!terminado.affected) {
      logger.log('info', `[CRON] Trial ${sub.id} ya no estaba en trial: no se degrada dos veces`)

      return false
    }

    await this.subscriptionEventRepo.save(
      this.subscriptionEventRepo.create({
        subscriptionId: sub.id,
        eventType: SubscriptionEventType.TRIAL_ENDED,
        fromStatus: SubscriptionStatus.TRIAL,
        toStatus: SubscriptionStatus.EXPIRED,
        triggeredBy: 'system',
        reason: `Trial vencido sin método de pago — degradado a ${freePlanSlug()}`,
      }),
    )

    this.eventBus.publishSubscriptionExpired({
      brandId: sub.brandId,
      subscriptionId: sub.id,
      planSlug: sub.planSlug,
    })
    await this.eventBus.notifySubscriptionExpired(sub.brandId, sub.planSlug)

    logger.log('info', `[CRON] Trial degradado a ${freePlanSlug()}: brandId=${sub.brandId}`)

    return true
  }

  /**
   * Extender periodo de la suscripción BILLING_PERIOD_DAYS días.
   */
  private async extendSubscriptionPeriod(sub: Subscription) {
    const newPeriodStart = new Date()
    const newPeriodEnd = new Date()
    newPeriodEnd.setDate(newPeriodEnd.getDate() + this.BILLING_PERIOD_DAYS)

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
